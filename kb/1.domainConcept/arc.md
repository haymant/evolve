# Arc
 
 ## Implementation in EVOLVE
 - Parsed into enginepy.pnml_parser.Arc with fields: id, source, target, inscriptions.
 - Used only for connectivity between places and transitions when building input/output maps.
 - Arc inscriptions are parsed but not executed by the engine.
 
 ## YAML shape (current parser support)
 - Under pnml -> net -> page -> arc (list).
 - Each arc entry supports:
   - id
   - source (place id or transition id)
   - target (transition id or place id)
 
 ## Runtime semantics
 - If source is a place and target is a transition, the arc is an input arc.
 - If source is a transition and target is a place, the arc is an output arc.
 - No weights, inhibitor arcs, or arc-specific token expressions are implemented.
