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
 
 ## Practical implications
 - The YAML model is tolerant but limited; only the supported keys influence runtime.
 - YAML structure is preserved for authoring, but only a subset is executed.
