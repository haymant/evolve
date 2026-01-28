# Code Generation
 
 ## Implemented generator
 - enginepy.project_gen.generate_python_project creates a runnable Python project under .vscode/evolve_py/<source>.
 - Generated files:
	 - main.py: entry point for running the net.
	 - inscriptions.py: functions generated from inline Python inscriptions.
	 - enginepy/: local copy of runtime modules (pnml_engine, pnml_parser, inscription_registry, vscode_bridge).
 
 ## Trigger points
 - LSP command evolve.generatePython (ls/server.py) generates the project for the active YAML.
 - DAP server (enginepy/pnml_dap.py) calls the generator automatically during debug sessions to register inscriptions.
 
 ## Limitations
 - Only inline Python inscriptions are generated; other languages are ignored.
