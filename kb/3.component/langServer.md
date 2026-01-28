# Language Server (Python)
 
 ## Implementation
 - Located at ls/server.py.
 - Implements a minimal JSON-RPC LSP server for YAML documents.
 
 ## Capabilities
 - Text sync (full document).
 - Document symbols: emits one symbol per place (from enginepy.pnml_parser.extract_place_index).
 - Execute commands:
	 - evolve.places: returns place ids and line ranges.
	 - evolve.generatePython: writes a generated Python project under .vscode/evolve_py.
