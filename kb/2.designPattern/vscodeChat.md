```markdown
# VS Code Chat Participant (Copilot) Integration

## Purpose in EVOLVE
Use a chat participant to support participant-flow async transitions:
- `/jobs` lists pending async operations.
- `/submit <token> <message>` resumes a pending operation by resume token.

## Key APIs (VS Code)
- `vscode.chat.createChatParticipant(id, handler)` registers the participant.
- `chatParticipants` contribution point defines name, description, slash commands.
- `ChatRequestHandler` receives:
	- `request.command` for slash commands
	- `request.prompt` for user input
	- `context.history` for participant history
	- `request.model` for selected LM (optional)
- `ChatResponseStream` supports:
	- `markdown`, `progress`, `button`, `filetree`, `reference`

## Minimal participant shape
```ts
const participant = vscode.chat.createChatParticipant('evolve', async (request, context, stream) => {
	if (request.command === 'jobs') {
		stream.markdown(renderJobs());
		return;
	}
	if (request.command === 'submit') {
		const [token, ...rest] = (request.prompt || '').split(/\s+/);
		await submitByToken(token, rest.join(' '));
		stream.markdown('Submitted.');
		return;
	}
	stream.markdown('Supported commands: /jobs, /submit <token> <message>');
});

participant.commands = [
	{ name: 'jobs', description: 'List pending async operations' },
	{ name: 'submit', description: 'Submit a pending operation by resume token' }
];
```

## Contribution (package.json)
```json
"contributes": {
	"chatParticipants": [
		{
			"id": "evolve",
			"name": "evolve",
			"fullName": "EVOLVE Async Ops",
			"description": "Manage pending EVOLVE async operations",
			"commands": [
				{ "name": "jobs", "description": "List pending async operations" },
				{ "name": "submit", "description": "Submit a pending operation by resume token" }
			]
		}
	]
}
```

## History usage
Use `context.history` if you need conversation-aware behavior. Only messages that mentioned the participant are visible.

## Output patterns for EVOLVE
- `/jobs` should list:
	- `operationId`, `resumeToken`
	- `transitionName`, `runId`, `netId`
	- timeout remaining
- `/submit` should pass `{ message, participantContext }` to async submit.

## Security and UX guidance
- Keep slash command names concise.
- Return actionable info when tokens are invalid.
- Avoid auto-opening chat UI on refusal. Return blocked state to the engine.

## References
- https://code.visualstudio.com/api/extension-guides/ai/chat
- https://code.visualstudio.com/api/extension-guides/ai/chat-tutorial
```
