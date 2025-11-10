import { spawn } from "child_process";

const pythonInterpreter =
  "/Users/lvhaoran/Desktop/languagelearn/pythonpro/mysite/.venv/bin/python";
const djangoSettingsModule = "mysite.settings";

const code = `
import os
import sys

sys.path.insert(0, "/Users/lvhaoran/Desktop/languagelearn/pythonpro/mysite/backend")

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "mysite.settings")

import django

django.setup()


def get_django_models():
    from django.apps import apps
    from django.db.models import ForeignKey

    models = {}

    for model in apps.get_models():
        model_name = model.__name__
        models[model_name] = {}

        for field in model._meta.get_fields():
            field_name = field.name
            field_type = field.__class__.__name__
            models[model_name][field_name] = {"type": field_type}
            if isinstance(field, ForeignKey):
                models[model_name][field_name]["related_model"] = (
                    field.related_model.__name__
                )

                # 假设性的添加一个 <field_name>_id 字段来表示外键ID
                models[model_name][f"{field_name}_id"] = {
                    "type": "IntegerField"  # 假设外键ID为整数类型
                }
    return models


def get_field_lookup():
    from django.db.models import fields
    import inspect

    field_lookups = {}
    for name, obj in inspect.getmembers(fields):
        if inspect.isclass(obj) and issubclass(obj, fields.Field):
            lookups = obj.get_lookups()
            field_lookups[name] = list(lookups.keys())
    return field_lookups


def run():
    from json import dumps

    get_django_models()
    get_field_lookup()
    print(dumps({"model": get_django_models(), "field_lookup": get_field_lookup()}))


run()
`;

export interface DjangoModel {
  model: {
    [modelName: string]: {
      [fieldName: string]: {
        type: string;
        related_model?: DjangoModel;
      };
    };
  };
  field_lookup: {
    [fieldType: string]: string[];
  };
}

export async function getDjangoModels(): Promise<DjangoModel> {
  return new Promise((resolve, reject) => {
    // 执行Python代码
    const pythonProcess = spawn(pythonInterpreter, ["-c", code]);

    pythonProcess.stdout.on("data", (data) => {
      resolve(JSON.parse(data));
    });

    pythonProcess.stderr.on("data", (data) => {
      console.log(`stderr: ${data}`);
      reject(data);
    });
  });
}

import { CompletionItem, CompletionItemKind, SignatureHelp } from "vscode";

export function getModelNameFromSignature(
  signatureHelp: SignatureHelp
): string {
  let modelName = "";
  for (const signature of signatureHelp.signatures) {
    // 假设模型名称在签名的标签中
    // def filter(self: QuerySet[ModelName, ...], *args, **kwargs) -> QuerySet[ModelName, ...]:
    const label = signature.label;
    const match = label.match(/QuerySet\[\s*([A-Za-z_]\w*)/);
    if (match) {
      modelName = match[1];
      break;
    }
  }
  return modelName;
}

export function genCompletionItemDocForDjangoModelField(
  modelName: string,
  djangoModels: DjangoModel,
  token: string = ""
): CompletionItem[] {
  const completionItems: CompletionItem[] = [];
  const model = djangoModels.model[modelName];
  if (!model) {
    return completionItems;
  }
  for (const fieldName in model) {
    const fieldInfo = model[fieldName];
    let doc = `${modelName} model field -> ${fieldInfo.type}`;
    if (fieldInfo.related_model) {
      doc += `, related to ${fieldInfo.related_model}`;
    }
    const item: CompletionItem = {
      label: `${fieldName}=`,
      documentation: doc,
      kind: CompletionItemKind.Field,
    };
    completionItems.push(item);

    // 如果有 token，添加 lookup 提示
    if( token && fieldName.startsWith(token)) {
        const lookups = djangoModels.field_lookup[fieldInfo.type];
        if (lookups) {
          for (const lookup of lookups) {
            const lookupItem: CompletionItem = {
              label: `${fieldName}__${lookup}=`,
              documentation: `${modelName} model field lookup -> ${fieldInfo.type}__${lookup}`,
              kind: CompletionItemKind.Field,
            };
            completionItems.push(lookupItem);
          }
        }
    }
  }

  return completionItems;
}
