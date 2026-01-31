# Declaration Context
 
 ## Current implementation
 - There is no declaration context parser or runtime support in enginepy.
 - YAML sections beyond the supported net/place/transition/arc/inscriptions/initialTokens are ignored by the parser.
 
 ## Implications
 - No typed declarations, constants, or variable scopes are available at runtime.
 - Inscription code runs as raw Python functions generated from inline code.

## Schema vs runtime
- Schema documents (PNML JSON schema) include declarations metadata, but runtime ignores them.
- This is validation-only today; execution uses only parsed elements in [enginepy/pnml_parser.py](enginepy/pnml_parser.py).
