# Code Execution and Environment
 
 ## Current behavior
 - The extension uses PYTHON_PATH if set; otherwise python3 (or python on Windows).
 - Run mode executes either generated main.py or enginepy.pnml_engine in a terminal.
 - Debug mode launches enginepy.pnml_dap.py as a debug adapter executable.
 
 ## What is not implemented
 - No automatic virtual environment creation or dependency management.
 - The runtime assumes Python is available on PATH.
