```markdown
# VS Code Webview Pattern

## Purpose in EVOLVE
Use a webview to render dynamic forms for async transitions, and to resume pending operations with structured input.

## Core APIs
- `vscode.window.createWebviewPanel(viewType, title, column, options)`
- `panel.webview.html` sets full HTML
- `panel.webview.postMessage(data)` send data to webview
- `panel.webview.onDidReceiveMessage(handler)` receive data from webview
- `panel.onDidDispose` cleanup
- `panel.reveal()` bring panel to foreground

## Required webview options
```ts
const panel = vscode.window.createWebviewPanel(
	'evolve.asyncForm',
	'EVOLVE Form',
	vscode.ViewColumn.One,
	{
		enableScripts: true,
		localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
	}
);
```

## Messaging pattern
**Extension → Webview**
```ts
panel.webview.postMessage({ type: 'init', formSpec });
```

**Webview → Extension**
```js
const vscode = acquireVsCodeApi();
vscode.postMessage({ type: 'submit', data: formValues });
```

## Security requirements
- Use strict Content Security Policy (no remote scripts).
- Use `webview.asWebviewUri` for local assets.
- Sanitize all user/workspace data injected into HTML.
- Avoid `retainContextWhenHidden` unless necessary.

## Persistence
- Use `vscode.getState()`/`setState()` in the webview to persist form state.
- Optionally use `registerWebviewPanelSerializer` to restore after reloads.

## EVOLVE-specific guidance
- Store `operationId` and `resumeToken` in webview state.
- If panel is closed, keep pending op in store and reopen via `evolve.resumeForm`.

## References
- https://code.visualstudio.com/api/extension-guides/webview
```
