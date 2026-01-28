# Flow: Execute and Debug PNML
 
 ## Run flow
 - Command evolve.runNet runs the YAML in a terminal.
 - Uses generated main.py when available; otherwise runs enginepy.pnml_engine directly.
 
 ## Debug flow
 - Command evolve.debugNet launches evolve-pnml debug adapter.
 - Breakpoints map to place ids; stepping and continue are supported.
 - Marking and history are exposed in the debug variables view.
