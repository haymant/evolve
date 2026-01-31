# Transition
 
 ## Implementation in EVOLVE
 - Represented by enginepy.pnml_parser.Transition with fields: id and inscriptions.
 - Transitions are stored in PNMLNet.transitions by id.
 
 ## YAML shape (current parser support)
 - Under pnml -> net -> page -> transition (list).
 - Inscriptions are supported under:
	 - evolve -> inscriptions -> list with id, language, kind, source, code.
 
 ## Runtime semantics
 - Enabled if all input places (from arcs) contain at least one token.
 - PNMLEngine.step_once selects the first enabled transition.
 - Guard inscriptions are evaluated before firing; if any returns falsy, the transition is blocked.
 - Expression inscriptions are executed after firing, with a token argument when available.

## Async execution
- `execMode: async` expressions return an `AsyncResult` to pause/resume execution.
- The async result is appended to output tokens when it completes.
- Implementation: [enginepy/pnml_engine.py](enginepy/pnml_engine.py).

## Example (YAML)
```yaml
transition:
	- id: t1
		evolve:
			inscriptions:
				- id: in1
					language: python
					kind: guard
					source: inline
					code: |
						return token is not None
				- id: in2
					language: python
					kind: expression
					execMode: async
					source: inline
					code: |
						from enginepy import vscode_bridge
						return vscode_bridge.chat_async("hello")
```
