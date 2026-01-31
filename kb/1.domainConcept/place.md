# Place
 
 ## Implementation in EVOLVE
 - Represented by enginepy.pnml_parser.Place with fields: id and tokens.
 - Initial tokens are read from evolve.initialTokens as a list of value entries.
 - Values are parsed as scalar types (string, int, float, bool), otherwise kept as raw strings.
 
 ## YAML shape (current parser support)
 - Under pnml -> net -> page -> place (list).
 - Initial tokens are supported via:
	 - evolve -> initialTokens -> list of value items.
 
 ## Runtime semantics
 - Tokens are stored as a list per place in PNMLEngine.marking.
 - A transition is enabled if all its input places have at least one token.
 - When a transition fires, one token is removed from each input place.

## Place indexing (editor + debug)
- Place lines are extracted by `extract_place_index` for symbols and breakpoints.
- Used by the editor and DAP to map place ids to lines.
- Implementation: [enginepy/pnml_parser.py](enginepy/pnml_parser.py), [editor/src/placeIndex.ts](editor/src/placeIndex.ts).

## Example (YAML)
```yaml
place:
	- id: p1
		evolve:
			initialTokens:
				- value: Red
```
