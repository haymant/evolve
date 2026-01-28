# EVOLVE Editor (VS Code Extension)

This package hosts the VS Code extension for editing `evolve-hlpn` YAML networks. It connects to two language servers:
- **yaml-language-server** for base YAML validation + JSON Schema support.
- **evolvels** for EVOLVE-specific semantic diagnostics.

## Development
### Prerequisites
- Node.js 18+
- npm
- VS Code

### Install
```bash
npm --prefix editor install
npm --prefix evolvels install
```

### Build
```bash
npm --prefix evolvels run build
npm --prefix editor run build
```

## Manual Integration Testing
Automated integration testing is not feasible in this environment because VS Code extension hosts require a UI session. Use the steps below to verify integration manually.

1) **Build LSP + Editor**
```bash
npm --prefix evolvels run build
npm --prefix editor run build
```

2) **Launch the Extension Host**
- Open the workspace root in VS Code.
- Use the launch configuration: **Run EVOLVE Extension**.

3) **Verify LSP Wiring**
- Create a file like `sample.pnml.yaml`.
- Paste invalid YAML to confirm base YAML diagnostics (from yaml-language-server).
- Paste EVOLVE-specific issues to confirm semantic diagnostics:
  - Missing `nets` array
  - `type` not equal to `evolve-hlpn`
  - `kind: manual` without `manual` config
  - Arc endpoints referencing missing nodes

4) **Verify Command**
- Run **EVOLVE: Open Graph Editor** from the command palette.
- Confirm the placeholder message appears.

## Notes
- The EVOLVE LSP server runs from `evolvels/dist/server.js`.
- If you see “Cannot find module .../dist/server.js”, build `evolvels` first.
