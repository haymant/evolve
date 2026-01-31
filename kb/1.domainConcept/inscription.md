# Inscription
 
 ## Implementation in EVOLVE
 - Parsed into enginepy.pnml_parser.Inscription with fields:
	 - id, language, kind, source, code
	 - owner_id, registry_key, func (resolved at runtime)
 - Registry keys are built with enginepy.inscription_registry.build_registry_key.
 - Only Python inscriptions are executed by the engine.
 
 ## YAML shape (current parser support)
 - Under evolve -> inscriptions in transitions or arcs.
 - Supported fields:
	 - id, language, kind, source, code (code supports block scalar |).
 
 ## Runtime semantics
 - kind guard: evaluated before firing; a falsy result blocks firing.
 - kind expression: executed after firing, receives one token when available.
 - Other kinds are parsed but not executed by PNMLEngine.
 
 ## Code generation
 - enginepy.project_gen.generate_python_project converts inline Python code into functions.
 - Guard with a single-line expression is rewritten to return the expression unless it already returns or prints.
 - Each function is registered into the inscription registry for lookup at runtime.

## Async helper
- `vscode_bridge.chat_async` returns an `AsyncResult` suitable for `execMode: async`.
- Async results are wired via callbacks to resume token flow.

## Example (inscription entry)
```yaml
inscriptions:
	- id: in_async
		language: python
		kind: expression
		execMode: async
		source: inline
		code: |
			from enginepy import vscode_bridge
			return vscode_bridge.chat_async("Summarize this net")
```
