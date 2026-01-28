# VS Code Bridge (Python)
 
 ## Implementation
 - enginepy/vscode_bridge.py exposes a synchronous API for inscriptions.
 - Initialized by enginepy/pnml_dap.PNMLDAPServer during debug sessions.
 - In run mode, calls raise RuntimeError.
 
 ## Request flow
 1. Python inscription calls vscode_bridge.chat/execute_command/get_chat_history/show_message.
 2. VSCodeBridge sends a custom request to the DAP server.
 3. DAP server emits a customRequest event to the VS Code extension.
 4. Extension handles the request and responds via customRequestResponse.
 5. DAP server returns the result to the bridge call.
 
 ## Supported requests
 - vscode/chat
 - vscode/executeCommand
 - vscode/getChatHistory
 - vscode/showMessage
 
 ## Timeouts
 - Each request can include a timeout (milliseconds). The DAP server enforces it.