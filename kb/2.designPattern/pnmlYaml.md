# PNML YAML
 
 ## Parser behavior (enginepy)
 - enginepy.pnml_parser.parse_pnml is indentation-driven and only consumes specific keys.
 - Supported keys for semantics: net, place, transition, arc, initialTokens, inscriptions.
 - Other keys (page, evolve, name, type) are treated as nesting and do not affect runtime.
- Inscription metadata supported by parser: id, language, kind, source, code, execMode.
 
 ## Editor behavior
 - The extension uses the YAML language server when available and applies schema/pnml.schema.
 - Place indexing and inscription extraction use the YAML AST (editor/src/placeIndex.ts and editor/src/inscripted.ts).

## Schema extension
- The JSON schema defines evolveInscription fields such as languageVersion, signature, timeout, sandbox, and execMode.
- Runtime currently executes execMode (sync/async) but ignores other metadata fields (validation-only).

## Validation source
- Schema file: [schema/pnml.schema](schema/pnml.schema).

## Example (execMode)
```yaml
inscriptions:
	- id: in2
		language: python
		kind: expression
		execMode: async
		source: inline
		code: |
			from enginepy import vscode_bridge
			return vscode_bridge.chat_async("ping")
```
 
 ## Practical implications
 - The YAML model is tolerant but limited; only the supported keys influence runtime.
 - YAML structure is preserved for authoring, but only a subset is executed.

## Best practices for async inscriptions (avoid common mistakes)
- Always return host AsyncOpRequest objects from async inscriptions.
  - Correct: use an explicit `return` statement that returns the `AsyncOpRequest` (for example, `return vscode_bridge.participant_async(...)`) so the engine receives the pending operation and pauses execution.
  - Incorrect: wrapping the call in a lambda like `lambda d: vscode_bridge.participant_async(...)` creates a function object rather than returning an `AsyncOpRequest`. The engine will not pause and may proceed to `END`.
- Use block scalar (`|`) for multi-line Python code so the parser captures full code text including `return` lines.
- Provide an `id` for inscriptions whenever possible. The parser uses the `id` when creating registry keys; missing ids can make tracing and testing harder.

### Good example
```yaml
inscriptions:
  - id: in_participant
    language: python
    kind: expression
    execMode: async
    source: inline
    code: |
      # Return an AsyncOpRequest so the engine pauses for host input
      return vscode_bridge.participant_async("reviewer", {"prompt": "Approve?"})
```

### Bad example (common bug)
```yaml
inscriptions:
  - language: python
    kind: expression
    execMode: async
    source: inline
    code: "lambda d: vscode_bridge.participant_async('reviewer')"
```

### Recommended tests / CI checks
- Unit test: parse canonical example YAML (like `examples/evolve.evolve.yaml`) and assert that:
  - Async inscriptions contain `return <vscode_bridge>_...` (not `lambda`).
  - Inscription `id` exists for critical transitions.
- Lint rule (optional): add a pre-commit linter that flags async inscriptions without `return` or using single-line lambda expressions.
- Integration test: run the net and verify engine pauses at the expected PendingOp when the async inscription executes.

These practices will reduce parser/runtime mismatches and prevent silent failures where async code does not pause the engine.
