# VS Code Extension Patterns
 
 ## Implemented integration points
 - Commands: evolve.openGraphEditor, evolve.toggleBreakpoint, evolve.runNet, evolve.debugNet, evolve.showRunMenu, evolve.openInscriptionEditor, evolve.openInscriptionAtCursor.
 - Debug adapter: evolve-pnml uses enginepy/pnml_dap.py.
 - Debug adapter tracker: listens for customRequest events and responds with customRequestResponse.
 - Virtual file system provider: evolve-inscription exposes inline inscription code as virtual files.
 - Code lenses: show Edit inscription links on YAML inscriptions.
 
 ## Copilot chat integration
 - Uses VS Code Language Model API to send chat requests.
 - Model selection order: request param model, setting evolve.copilot.defaultModel, fallback to first Copilot model.
 
 ## Editor validation
 - YAML language server is wired when installed; schema/pnml.schema is applied to *.pnml.yaml and *.evolve.yaml.
