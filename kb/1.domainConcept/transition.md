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
