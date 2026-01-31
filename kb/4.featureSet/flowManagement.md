# Flow: Manage Execution and Interaction
 
 ## Breakpoint management
 - Breakpoints are restricted to EVOLVE YAML files and mapped to place ids.
 - Breakpoints in generated inscriptions.py are synchronized with YAML inscription lines.
 
 ## Debug introspection
 - Debug scopes expose Marking (tokens per place) and History entries.
 - Stack frames map to place lines or inscription lines when stepping.
 
 ## VS Code bridge interaction
 - During debug, inscriptions can call VSCodeBridge APIs for chat and editor actions.

## Marking output
- Debug adapter prints marking snapshots and final marking to the debug console.
