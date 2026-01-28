# PNML Engine (Python)
 
 ## Parser
 - enginepy.pnml_parser.parse_pnml builds PNMLNet, PlaceIndex, and Inscription objects.
 - Handles net, place, transition, arc, initialTokens, and inscriptions sections.
 
 ## Execution
 - enginepy.pnml_engine.PNMLEngine executes token flow.
 - Transition selection is deterministic: the first enabled transition fires.
 - Guard and expression inscriptions are executed if registered.
- execMode: async expressions pause execution and resume when AsyncResult completes.
- Async token emission: moved input tokens are preserved and any async result is appended to output places.
 
 ## Debug adapter
 - enginepy.pnml_dap.PNMLDAPServer implements the Debug Adapter Protocol.
 - Breakpoints map to place ids; stepping yields HistoryEntry and marking snapshots.
 - Supports custom requests for VS Code bridge during debug sessions.
