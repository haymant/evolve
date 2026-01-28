# VS Code Host Integration
 
 ## Implemented host responsibilities
 - Spawns the debug adapter for evolve-pnml using enginepy/pnml_dap.py.
 - Registers a DebugAdapterTracker that handles customRequest events from DAP.
 - Routes bridge requests to handlers: chat, executeCommand, getChatHistory, showMessage.
 
 ## Copilot chat handling
 - Selects Copilot models via the VS Code Language Model API.
 - Maintains in-memory chat history per conversation id.
 - Detects refusal/off-topic responses and optionally opens the chat UI.
