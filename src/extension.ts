/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 */

import {ExtensionContext, workspace} from 'vscode';
import * as vscode from 'vscode';
import {
  CancellationToken,
  ConfigurationItem,
  ConfigurationParams,
  ConfigurationRequest,
  LanguageClient,
  LanguageClientOptions,
  LSPAny,
  ResponseError,
  ServerOptions,
} from 'vscode-languageclient/node';
import {PythonExtension} from '@vscode/python-extension';
import { genCompletionItemDocForDjangoModelField, getDjangoModels, getModelNameFromSignature } from './analizer/djangoModel';
import { pyreflyConfig } from './config';

let client: LanguageClient;
let outputChannel: vscode.OutputChannel;

// 自定义全局变量
let djangoModels = {
  model: {},
  field_lookup: {},
}

/// Get a setting at the path, or throw an error if it's not set.
function requireSetting<T>(path: string): T {
  const ret: T | undefined = vscode.workspace.getConfiguration().get(path);
  if (ret == undefined) {
    throw new Error(`Setting "${path}" was not configured`);
  }
  return ret;
}


async function getDocstringRanges(
  document: vscode.TextDocument,
): Promise<vscode.Range[]> {
  const identifier = client.code2ProtocolConverter.asTextDocumentIdentifier(
    document,
  );
  const response = (await client.sendRequest(
    'pyrefly/textDocument/docstringRanges',
    identifier,
  )) as Array<{
    start: {line: number; character: number};
    end: {line: number; character: number};
  }> | null;

  if (!response) {
    return [];
  }

  return response.map(range => client.protocol2CodeConverter.asRange(range));
}

async function runDocstringFoldingCommand(
  commandId: 'editor.fold' | 'editor.unfold',
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (
    editor == null ||
    editor.document.uri.scheme !== 'file' ||
    editor.document.languageId !== 'python'
  ) {
    return;
  }

  try {
    const ranges = await getDocstringRanges(editor.document);
    if (ranges.length === 0) {
      return;
    }

    const seen = new Set<string>();
    const uniqueRanges = ranges.filter(range => {
      const key = `${range.start.line}:${range.start.character}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });

    const selectionLines = uniqueRanges
      .map(range => {
        if (range.start.line === range.end.line) {
          return null;
        }
        return range.start.line;
      })
      .filter((line): line is number => line != null)
      .filter((line, index, arr) => arr.indexOf(line) === index)
      .sort((a, b) => a - b);

    if (selectionLines.length === 0) {
      return;
    }

    await vscode.commands.executeCommand(commandId, {
      selectionLines,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : `Unknown error: ${String(error)}`;
    outputChannel?.appendLine(
      `Failed to ${commandId === 'editor.fold' ? 'fold' : 'unfold'} docstrings: ${message}`,
    );
  }
}

/**
 * This function adds the pythonPath to any section with configuration of 'python'.
 * Our language server expects the pythonPath from VSCode configurations but this setting is not stored in VSCode
 * configurations. The Python extension used to store pythonPath in this section but no longer does. Details:
 * https://github.com/microsoft/pyright/commit/863721687bc85a54880423791c79969778b19a3f
 *
 * Example:
 * - Pyrefly asks for a configurationItem for {scopeUri: '/home/project', section: 'python'}
 * - VSCode returns a configuration of {setting: 'value'} from settings.json
 * - This function will add pythonPath: '/usr/bin/python3' from the Python extension to the configuration
 * - {setting: 'value', pythonPath: '/usr/bin/python3'} is returned
 *
 * @param pythonExtension the python extension API
 * @param configurationItems the sections within the workspace
 * @param configuration the configuration returned by vscode in response to a workspace/configuration request (usually what's in settings.json)
 * corresponding to the sections described in configurationItems
 */
async function overridePythonPath(
  pythonExtension: PythonExtension,
  configurationItems: ConfigurationItem[],
  configuration: (object | null)[],
): Promise<(object | null)[]> {
  const getPythonPathForConfigurationItem = async (index: number) => {
    if (
      configurationItems.length <= index ||
      configurationItems[index].section !== 'python'
    ) {
      return undefined;
    }
    let scopeUri = configurationItems[index].scopeUri;
    const pythonPath =  await pythonExtension.environments.getActiveEnvironmentPath(
      scopeUri === undefined ? undefined : vscode.Uri.parse(scopeUri),
    ).path;
    return pythonPath;
  };
  const newResult = await Promise.all(
    configuration.map(async (item, index) => {
      const pythonPath = await getPythonPathForConfigurationItem(index);
      if (pythonPath === undefined) {
        return item;
      } else {
        return {...item, pythonPath};
      }
    }),
  );
  return newResult;
}

export async function activate(context: ExtensionContext) {
  // Initialize the output channel if it doesn't exist
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel(
      'Pyrefly language server',
    );
  }

  const path: string = requireSetting('pyrefly.lspPath');
  const args: [string] = requireSetting('pyrefly.lspArguments');

  const bundledPyreflyPath = vscode.Uri.joinPath(
    context.extensionUri,
    'bin',
    // process.platform returns win32 on any windows CPU architecture
    process.platform === 'win32' ? 'pyrefly.exe' : 'pyrefly',
  );

  let pythonExtension = await PythonExtension.api();

  // Otherwise to spawn the server
  let serverOptions: ServerOptions = {
    command: path === '' ? bundledPyreflyPath.fsPath : path,
    args: args,
  };
  let rawInitialisationOptions = vscode.workspace.getConfiguration('pyrefly');
  console.log('Pyrefly initialisation options:', rawInitialisationOptions);

  async function overridePythonPathConfiguration(
    params: ConfigurationParams,
    token: CancellationToken,
    next: ConfigurationRequest.HandlerSignature
  ): Promise<LSPAny[] | ResponseError<void>> {
    const result = await next(params, token);
    if (result instanceof ResponseError) {
      return result;
    }
    let newResult = await overridePythonPath(
      pythonExtension,
      params.items,
      result as (object | null)[]
    );
    console.log("Overridden configuration result:", newResult);

    newResult = newResult.map((item, index) => {
      return {...item, pyrefly: pyreflyConfig} 
    });
    console.log("Overridden configuration result:", newResult);
    return newResult;
  }

  // Options to control the language client
  let clientOptions: LanguageClientOptions = {
    initializationOptions: rawInitialisationOptions,
    // Register the server for Python documents
    documentSelector: [
      { scheme: "file", language: "python" },
      // Support for notebook cells
      { scheme: "vscode-notebook-cell", language: "python" },
    ],
    // Support for notebooks
    // @ts-ignore
    notebookDocumentSync: {
      notebookSelector: [
        {
          notebook: { notebookType: "jupyter-notebook" },
          cells: [{ language: "python" }],
        },
      ],
    },
    outputChannel: outputChannel,
    middleware: {
      workspace: {
        configuration: overridePythonPathConfiguration,
      },
    },
  };

  // Create the language client and start the client.
  client = new LanguageClient(
    'pyrefly',
    'Pyrefly language server',
    serverOptions,
    clientOptions,
  );


  context.subscriptions.push(
    vscode.commands.registerCommand('pyrefly.restartClient', async () => {
      await client.stop();
      // Clear the output channel but don't dispose it
      outputChannel.clear();
      client = new LanguageClient(
        'pyrefly',
        'Pyrefly language server',
        serverOptions,
        clientOptions,
      );
      await client.start();
    }),
  );

  // 注册一个智能提示器提供者
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      { scheme: 'file', language: 'python' },
      {
        async provideCompletionItems(
          document: vscode.TextDocument,
          position: vscode.Position,
          token: vscode.CancellationToken,
          context: vscode.CompletionContext,
        ): Promise<vscode.CompletionItem[] | undefined> {
            // Ask the server for signature help at the current position.
            const params = client.code2ProtocolConverter.asTextDocumentPositionParams(
              document,
              position,
            );
            const signatureHelp = await client.sendRequest<any>(
              'textDocument/signatureHelp',
              params,
            );

            if (!signatureHelp) {
              return undefined;
            }
            
            // 找到当前光标到 '(' 或 ',' 之间的文本，作为过滤token
            // 优先找 ',', 如果没有找到，则找 '('
            const lineText = document.lineAt(position.line).text;
            let filterToken = "";
            for (let i = position.character - 1; i >= 0; i--) {
              const char = lineText[i];
              if (char === ',' || char === '(') {
                break;
              }
              filterToken = char + filterToken;
            }
            filterToken = filterToken.trim();

            

            // Derive the model name from the signature help using the helper.
            const modelName = getModelNameFromSignature(signatureHelp);
            const result = genCompletionItemDocForDjangoModelField(modelName, djangoModels, filterToken);
            return result;
        },
      },
      "(",
      ",",
      "_"
    ),
  );

  // Start the client. This will also launch the server
  await client.start();

  djangoModels = await getDjangoModels();

  console.log('collected Django Models:', djangoModels);

}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  // Dispose the output channel when the extension is deactivated
  if (outputChannel) {
    outputChannel.dispose();
  }
  return client.stop();
}
