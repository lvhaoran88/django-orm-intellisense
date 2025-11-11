

export const pyreflyConfig = {
  displayTypeErrors: "force-off",
  analysis: {
    disabledLanguageServices: {
      hover: true,
      documentSymbol: true,
      workspaceSymbol: true,
      inlayHint: true,
      completion: true,
      codeAction: true,
      definition: true,
      typeDefinition: true,
      references: true,
      documentHighlight: true,
      rename: true,
      codeLens: true,
      semanticTokens: true,
      signatureHelp: false,
    },
  },
};