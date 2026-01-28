import * as path from "path";
import * as vscode from "vscode";
import * as http from "http";
import * as crypto from "crypto";
import WebSocket, { WebSocketServer } from "ws";
import {
  extractInscriptions,
  updateInscriptionText,
  getInscriptionLangExt,
  buildInscriptionUri
} from "./inscripted";
import { extractPlaceIndex, findPlaceForLine } from "./placeIndex";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;
let yamlClient: LanguageClient | undefined;
const generatedModules = new Map<string, string>();
const chatHistory = new Map<string, Array<{ role: string; content: string; timestamp: number }>>();

type RunBridgeInfo = {
  addr: string;
  token: string;
  sessionId: string;
  port: number;
};

let runBridgeServer: http.Server | undefined;
let runBridgeSocketServer: WebSocketServer | undefined;
let runBridgeInfo: RunBridgeInfo | undefined;

const isCopilotAvailable = async (): Promise<boolean> => {
  try {
    const models = await (vscode as any).lm.selectChatModels({ vendor: 'copilot' });
    return Array.isArray(models) && models.length > 0;
  } catch {
    return false;
  }
};

export function activate(context: vscode.ExtensionContext): void {
  const schemaPath = path.join(context.extensionPath, '..', 'schema', 'pnml.schema');
  const schemaUri = vscode.Uri.file(schemaPath).toString();
  const schemaPatterns = ['**/*.pnml.yaml', '**/*.evolve.yaml'];

  const yamlServerModule = (() => {
    try {
      return require.resolve("yaml-language-server/bin/yaml-language-server");
    } catch {
      return undefined;
    }
  })();

  if (yamlServerModule) {
    const yamlServerOptions: ServerOptions = {
      run: { command: process.execPath, args: [yamlServerModule, "--stdio"] },
      debug: { command: process.execPath, 
        args: [yamlServerModule, "--stdio", "--log-level", "debug", "--inspect=6009", "--nolazy"]
       }
    };

    const yamlClientOptions: LanguageClientOptions = {
      documentSelector: [
        { language: "yaml", pattern: "**/*.pnml.yaml" },
        { language: "yaml", pattern: "**/*.evolve.yaml" }
      ],
      initializationOptions: {
        yaml: {
          validate: true,
          schemas: {
            [schemaUri]: schemaPatterns
          }
        }
      },
      synchronize: {
        configurationSection: ['yaml']
      },
      middleware: {
        workspace: {
          configuration: (params, _token, next) => {
            if (!params || !Array.isArray(params.items)) {
              return next(params, _token);
            }
            const settings = params.items.map((item) => {
              if (item.section === 'yaml') {
                return {
                  validate: true,
                  schemas: {
                    [schemaUri]: schemaPatterns
                  }
                };
              }
              return null;
            });
            return Promise.resolve(settings);
          }
        }
      }
    };

    yamlClient = new LanguageClient(
      "evolveYamlBaseLsp",
      "EVOLVE YAML Language Server",
      yamlServerOptions,
      yamlClientOptions
    );

    // LanguageClient.start() returns a Thenable<void>. Push a disposable that stops the client when disposed.
    yamlClient.start().then(() => {
      context.subscriptions.push({ dispose: () => yamlClient && yamlClient.stop() });
    });
  }

  const pythonCmd = process.env.PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3');
  const serverModule = path.join(context.extensionPath, "..", "ls", "server.py");

  const serverOptions: ServerOptions = {
    run: {
      command: pythonCmd,
      args: ["-u", serverModule],
      transport: TransportKind.stdio
    },
    debug: {
      command: pythonCmd,
      args: ["-u", serverModule],
      transport: TransportKind.stdio
    }
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { language: "yaml", pattern: "**/*.pnml.yaml" },
      { language: "yaml", pattern: "**/*.evolve.yaml" }
    ],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher(
        "**/*.{pnml.yaml,evolve.yaml}"
      )
    }
  };

  client = new LanguageClient(
    "evolveHlpnLsp",
    "EVOLVE HLPN Language Server",
    serverOptions,
    clientOptions
  );

  // LanguageClient.start() returns a Thenable<void>. Push a disposable that stops the client when disposed.
  client.start().then(() => {
    context.subscriptions.push({ dispose: () => client && client.stop() });
  });

  const openGraphEditor = vscode.commands.registerCommand(
    "evolve.openGraphEditor",
    () => {
      vscode.window.showInformationMessage(
        "EVOLVE Graph Editor will open here once the webview is implemented."
      );
    }
  );

  // Command to toggle a breakpoint at the current cursor line. Restricted to .pnml.yaml and .evolve.yaml files.
  const allowedBreakpointFile = (uri: any) => {
    if (!uri) return false;
    if (uri.scheme === 'evolve-inscription') return true;
    const rawPath = (uri.fsPath || uri.path || '').toString();
    const path = rawPath.replace(/\\/g, '/').toLowerCase();
    if (path.includes('/.vscode/evolve_py/') && path.endsWith('/inscriptions.py')) {
      return true;
    }
    return path.endsWith('.pnml.yaml') || path.endsWith('.evolve.yaml');
  };

  let notifiedBreakpointLimit = false;

  const toggleBpCmd = vscode.commands.registerCommand("evolve.toggleBreakpoint", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage("No active editor to toggle a breakpoint.");
      return;
    }
    const uri = editor.document.uri;
    if (!allowedBreakpointFile(uri)) {
      if (!notifiedBreakpointLimit) {
        vscode.window.showInformationMessage(
          "Breakpoints are only supported in EVOLVE files (*.pnml.yaml, *.evolve.yaml)."
        );
        notifiedBreakpointLimit = true;
      }
      return;
    }
    // Toggle by delegating to built-in command when allowed
    await vscode.commands.executeCommand('editor.debug.action.toggleBreakpoint');
  });

  // Listen for breakpoints added in the workspace and remap to place.id lines when needed.
  let adjustingBreakpoints = false;
  const bpListener = (vscode as any).debug.onDidChangeBreakpoints((ev: any) => {
    if (adjustingBreakpoints) return;
    adjustingBreakpoints = true;
    (async () => {
      const toRemove: any[] = [];
      const toAdd: any[] = [];

      // Handle removed breakpoints - sync removal between YAML and Python
      for (const bp of ev.removed) {
        const location = bp && bp.location;
        const uri = location && location.uri;
        if (!uri) continue;
        
        const rawPath = (uri.fsPath || uri.path || '').toString();
        const normalizedPath = rawPath.replace(/\\/g, '/').toLowerCase();
        
        // If removed from inscriptions.py, find and remove from YAML
        if (normalizedPath.includes('/.vscode/evolve_py/') && normalizedPath.endsWith('/inscriptions.py')) {
          const yamlUri = Array.from(generatedModules.entries()).find(([_, dir]) => 
            normalizedPath.includes(dir.replace(/\\/g, '/').toLowerCase())
          )?.[0];
          if (yamlUri) {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(yamlUri));
            const line = location.range.start.line;
            const inscriptions = extractInscriptions(doc.getText());
            const map = buildGeneratedInscriptionLineMap(doc.getText());
            for (const ins of inscriptions) {
              const entry = map.get(ins.index);
              if (entry && line >= entry.codeStartLine && line < entry.codeStartLine + entry.codeLineCount) {
                if (ins.range) {
                  const yamlLine = ins.range.start + (line - entry.codeStartLine);
                  const yamlPos = new (vscode as any).Position(yamlLine, 0);
                  const yamlLoc = new (vscode as any).Location(vscode.Uri.parse(yamlUri), yamlPos);
                  const yamlBps = vscode.debug.breakpoints.filter((b: any) => 
                    b.location && b.location.uri.toString() === yamlUri && 
                    b.location.range.start.line === yamlLine
                  );
                  toRemove.push(...yamlBps);
                }
                break;
              }
            }
          }
          continue;
        }
        
        // If removed from YAML in inscription code, remove from Python
        if (allowedBreakpointFile(uri) && uri.scheme !== 'evolve-inscription') {
          const doc = await vscode.workspace.openTextDocument(uri);
          const line = location.range.start.line;
          if (isInInscriptionCode(doc.getText(), line)) {
            const moduleDir = generatedModules.get(uri.toString());
            if (moduleDir) {
              const info = getInscriptionForLine(doc.getText(), line);
              if (info) {
                const map = buildGeneratedInscriptionLineMap(doc.getText());
                const entry = map.get(info.ins.index);
                if (entry) {
                  const offset = Math.max(0, line - info.startLine);
                  const targetLine = entry.codeStartLine + Math.min(offset, entry.codeLineCount - 1);
                  const targetUri = vscode.Uri.file(path.join(moduleDir, 'inscriptions.py'));
                  const pyBps = vscode.debug.breakpoints.filter((b: any) => 
                    b.location && b.location.uri.fsPath === targetUri.fsPath && 
                    b.location.range.start.line === targetLine
                  );
                  toRemove.push(...pyBps);
                }
              }
            }
          }
        }
      }

      for (const bp of ev.added) {
        const location = bp && bp.location;
        const uri = location && location.uri;
        if (!uri || !allowedBreakpointFile(uri)) {
          toRemove.push(bp);
          continue;
        }
        const rawPath = (uri.fsPath || uri.path || '').toString();
        const normalizedPath = rawPath.replace(/\\/g, '/').toLowerCase();
        if (normalizedPath.includes('/.vscode/evolve_py/') && normalizedPath.endsWith('/inscriptions.py')) {
          continue;
        }
        if (uri.scheme === 'evolve-inscription') {
          continue;
        }
        const doc = await (vscode as any).workspace.openTextDocument(uri);
        const line = location.range.start.line;
        if (isInInscriptionCode(doc.getText(), line)) {
          const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          let moduleDir = generatedModules.get(uri.toString()) || '';
          if (!moduleDir && client) {
            const result = await client.sendRequest('workspace/executeCommand', {
              command: 'evolve.generatePython',
              arguments: [{ uri: uri.toString(), workspaceRoot }]
            });
            moduleDir = (result && (result as any).moduleDir) || '';
            if (moduleDir) {
              generatedModules.set(uri.toString(), moduleDir);
            }
          }
          const info = getInscriptionForLine(doc.getText(), line);
          if (moduleDir && info) {
            const map = buildGeneratedInscriptionLineMap(doc.getText());
            const entry = map.get(info.ins.index);
            if (entry) {
              const offset = Math.max(0, line - info.startLine);
              const targetLine = entry.codeStartLine + Math.min(offset, entry.codeLineCount - 1);
              const targetUri = vscode.Uri.file(path.join(moduleDir, 'inscriptions.py'));
              toRemove.push(bp);
              const pos = new (vscode as any).Position(targetLine, 0);
              const loc = new (vscode as any).Location(targetUri, pos);
              toAdd.push(new (vscode as any).SourceBreakpoint(loc, true));
              toAdd.push(new (vscode as any).SourceBreakpoint(location, true));
              continue;
            }
          }
          continue;
        }
        const places = extractPlaceIndex(doc.getText());
        const place = findPlaceForLine(places, line);
        if (!place) {
          toRemove.push(bp);
          continue;
        }
        if (line !== place.idLine) {
          toRemove.push(bp);
          const pos = new (vscode as any).Position(place.idLine, 0);
          const loc = new (vscode as any).Location(uri, pos);
          toAdd.push(new (vscode as any).SourceBreakpoint(loc, true));
        }
      }

      if (toRemove.length > 0) {
        (vscode as any).debug.removeBreakpoints(toRemove);
        if (!notifiedBreakpointLimit) {
          vscode.window.showInformationMessage(
            'Breakpoints are restricted to EVOLVE PNML files (*.pnml.yaml, *.evolve.yaml). Other breakpoints were removed.'
          );
          notifiedBreakpointLimit = true;
        }
      }
      if (toAdd.length > 0) {
        (vscode as any).debug.addBreakpoints(toAdd);
      }
    })().finally(() => {
      adjustingBreakpoints = false;
    });
  });

  // ===== InscriptEd: virtual inscription editor =====
  const allowedInscribeFile = (uri: any) => {
    if (!uri) return false;
    const p = (uri.path || '').toLowerCase();
    return p.endsWith('.pnml.yaml') || p.endsWith('.evolve.yaml');
  };

  const buildLineOffsets = (text: string) => {
    const offsets = [0];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\n') offsets.push(i + 1);
    }
    return offsets;
  };

  const positionAt = (offsets: number[], index: number) => {
    let low = 0;
    let high = offsets.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const start = offsets[mid];
      const next = mid + 1 < offsets.length ? offsets[mid + 1] : Number.MAX_SAFE_INTEGER;
      if (index < start) high = mid - 1;
      else if (index >= next) low = mid + 1;
      else return { line: mid, character: index - start };
    }
    return { line: 0, character: 0 };
  };

  const getInscriptionForLine = (text: string, line: number) => {
    const offsets = buildLineOffsets(text);
    const inscriptions = extractInscriptions(text);
    for (const ins of inscriptions) {
      if (!ins.range) continue;
      const start = positionAt(offsets, ins.range.start).line;
      const end = positionAt(offsets, ins.range.end).line;
      if (line >= start && line <= end) {
        const codeLines = (ins.code || '').split(/\r?\n/);
        return { ins, startLine: start, codeLines };
      }
    }
    return undefined;
  };

  const buildGeneratedInscriptionLineMap = (text: string) => {
    const inscriptions = extractInscriptions(text);
    const map = new Map<number, { codeStartLine: number; codeLineCount: number }>();
    // Header: comment, blank, import, blank = 4 lines
    let currentLine = 4;
    for (const ins of inscriptions) {
      const codeLines = (ins.code || '').split(/\r?\n/);
      const codeLineCount = Math.max(1, codeLines.length);
      // Structure: comment (currentLine), def (currentLine+1), code starts at (currentLine+2)
      const codeStartLine = currentLine + 1;
      map.set(ins.index, { codeStartLine, codeLineCount });
      // Advance: comment + def + code lines + blank + register_inscription + blank
      currentLine += 2 + codeLineCount + 2;
    }
    return map;
  };

  const isInInscriptionCode = (text: string, line: number) => {
    if (!text.includes('inscriptions:')) return false;
    const offsets = buildLineOffsets(text);
    const inscriptions = extractInscriptions(text);
    return inscriptions.some((ins) => {
      if (!ins.range) return false;
      const start = positionAt(offsets, ins.range.start).line;
      const end = positionAt(offsets, ins.range.end).line;
      return line >= start && line <= end;
    });
  };

  const buildInscriptionUriObj = (sourceUri: string, index: number, lang?: string) =>
    vscode.Uri.parse(buildInscriptionUri(sourceUri, index, lang));

  const fsEmitter = new (vscode as any).EventEmitter();
  const inscriptionFileSystem = (vscode as any).workspace.registerFileSystemProvider(
    'evolve-inscription',
    {
      onDidChangeFile: fsEmitter.event,
      watch(_uri: any, _options: any) {
        // No-op watcher; required by FileSystemProvider
        return { dispose() {} };
      },
      stat(_uri: any) {
        return { type: 1, ctime: Date.now(), mtime: Date.now(), size: 0 };
      },
      readDirectory() {
        return [] as any[];
      },
      createDirectory() {
        // no-op
      },
      readFile(uri: any) {
        const params = new URLSearchParams(uri.query);
        const source = params.get('source');
        const indexStr = params.get('index');
        if (!source || !indexStr) return Buffer.from('Missing source or index.', 'utf8');
        const index = parseInt(indexStr, 10);
        const sourceUri = vscode.Uri.parse(decodeURIComponent(source));
        const doc = (vscode as any).workspace.textDocuments.find((d: any) => d.uri.toString() === sourceUri.toString());
        if (!doc) return Buffer.from('Source document not found.', 'utf8');
        const inscriptions = extractInscriptions(doc.getText());
        const ins = inscriptions.find((i) => i.index === index);
        const content = ins && typeof ins.code === 'string' ? ins.code : '';
        return Buffer.from(content, 'utf8');
      },
      writeFile(uri: any, content: Uint8Array) {
        const params = new URLSearchParams(uri.query);
        const source = params.get('source');
        const indexStr = params.get('index');
        if (!source || !indexStr) return;
        const index = parseInt(indexStr, 10);
        const sourceUri = vscode.Uri.parse(decodeURIComponent(source));
        const text = Buffer.from(content).toString('utf8');
        (async () => {
          const sourceDoc = await (vscode as any).workspace.openTextDocument(sourceUri);
          const updated = updateInscriptionText(sourceDoc.getText(), index, text);
          const fullRange = new (vscode as any).Range(0, 0, sourceDoc.lineCount, 0);
          const edit = new (vscode as any).WorkspaceEdit();
          edit.replace(sourceUri, fullRange, updated);
          await (vscode as any).workspace.applyEdit(edit);
        })();
      },
      delete() {
        // no-op
      },
      rename() {
        // no-op
      }
    },
    { isCaseSensitive: true }
  );

  const openInscription = async (sourceUri: any, index: number, lang?: string) => {
    const uri = buildInscriptionUriObj(sourceUri.toString(), index, lang);
    const doc = await (vscode as any).workspace.openTextDocument(uri);
    const { id } = getInscriptionLangExt(lang);
    await (vscode as any).languages.setTextDocumentLanguage(doc, id);
    await (vscode as any).window.showTextDocument(doc, { preview: false });
  };

  const openInscriptionCmd = vscode.commands.registerCommand('evolve.openInscriptionEditor', async (sourceUri: string, index: number) => {
    const srcUri = vscode.Uri.parse(sourceUri);
    const doc = (vscode as any).workspace.textDocuments.find((d: any) => d.uri.toString() === srcUri.toString());
    if (!doc) return;
    const ins = extractInscriptions(doc.getText()).find((i) => i.index === index);
    await openInscription(srcUri, index, ins?.language);
  });

  const openInscriptionAtCursorCmd = vscode.commands.registerCommand('evolve.openInscriptionAtCursor', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const doc = editor.document;
    if (!allowedInscribeFile(doc.uri)) return;
    const text = doc.getText();
    const offsets = buildLineOffsets(text);
    const inscriptions = extractInscriptions(text);
    const line = editor.selection.active.line;
    const match = inscriptions.find((ins) => {
      if (!ins.range) return false;
      const start = positionAt(offsets, ins.range.start).line;
      const end = positionAt(offsets, ins.range.end).line;
      return line >= start && line <= end;
    });
    if (!match) {
      vscode.window.showInformationMessage('No inscription found at cursor.');
      return;
    }
    await openInscription(doc.uri, match.index, match.language);
  });

  const codeLensProvider = (vscode as any).languages.registerCodeLensProvider(
    [{ language: 'yaml', pattern: '**/*.{pnml.yaml,evolve.yaml}' }],
    {
      provideCodeLenses(document: any) {
        if (!allowedInscribeFile(document.uri)) return [];
        const text = document.getText();
        const offsets = buildLineOffsets(text);
        const inscriptions = extractInscriptions(text);
        const lenses = [] as any[];
        for (const ins of inscriptions) {
          if (!ins.range) continue;
          const startPos = positionAt(offsets, ins.range.start);
          const endPos = positionAt(offsets, ins.range.start);
          const range = new (vscode as any).Range(startPos.line, startPos.character, endPos.line, endPos.character);
          const title = `Edit inscription (${ins.language || 'unknown'})`;
          lenses.push(new (vscode as any).CodeLens(range, {
            title,
            command: 'evolve.openInscriptionEditor',
            arguments: [document.uri.toString(), ins.index]
          }));
        }
        return lenses;
      }
    }
  );


  const runNetCmd = vscode.commands.registerCommand('evolve.runNet', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !allowedBreakpointFile(editor.document.uri)) {
      vscode.window.showInformationMessage('Open a *.pnml.yaml or *.evolve.yaml file to run.');
      return;
    }
    const runBridgeEnabled = vscode.workspace.getConfiguration('evolve').get<boolean>('runBridge.enabled', true);
    let runBridgeEnv: { [key: string]: string } = {};
    if (runBridgeEnabled) {
      runBridgeEnv = await ensureRunBridge();
    }
    let moduleDir = '';
    if (client) {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const result = await client.sendRequest('workspace/executeCommand', {
        command: 'evolve.generatePython',
        arguments: [{ uri: editor.document.uri.toString(), workspaceRoot }]
      });
      moduleDir = (result && (result as any).moduleDir) || '';
      if (moduleDir) {
        generatedModules.set(editor.document.uri.toString(), moduleDir);
      }
    }
    const pythonCmd = process.env.PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3');
    const terminal = vscode.window.createTerminal({ name: 'EVOLVE Run', env: runBridgeEnv });
    const mainPy = moduleDir ? path.join(moduleDir, 'main.py') : '';
    if (moduleDir && mainPy) {
      terminal.sendText(`${pythonCmd} ${mainPy} ${editor.document.uri.fsPath}`);
    } else {
      terminal.sendText(`${pythonCmd} -m enginepy.pnml_engine ${editor.document.uri.fsPath}`);
    }
    terminal.show();
  });

  const debugNetCmd = vscode.commands.registerCommand('evolve.debugNet', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !allowedBreakpointFile(editor.document.uri)) {
      vscode.window.showInformationMessage('Open a *.pnml.yaml or *.evolve.yaml file to debug.');
      return;
    }
    if (client) {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const result = await client.sendRequest('workspace/executeCommand', {
        command: 'evolve.generatePython',
        arguments: [{ uri: editor.document.uri.toString(), workspaceRoot }]
      });
      const dir = (result && (result as any).moduleDir) || '';
      if (dir) {
        generatedModules.set(editor.document.uri.toString(), dir);
      }
    }
    await (vscode as any).debug.startDebugging(undefined, {
      type: 'evolve-pnml',
      name: 'Debug EVOLVE PNML',
      request: 'launch',
      program: editor.document.uri.fsPath
    });
  });

  const showRunMenuCmd = vscode.commands.registerCommand('evolve.showRunMenu', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !allowedBreakpointFile(editor.document.uri)) {
      vscode.window.showInformationMessage('Open a *.pnml.yaml or *.evolve.yaml file to run.');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      [
        { label: '$(play) Run EVOLVE PNML', id: 'run' },
        { label: '$(debug-alt) Debug EVOLVE PNML', id: 'debug' }
      ],
      { placeHolder: 'Select action' }
    );
    if (!pick) return;
    if (pick.id === 'run') {
      await vscode.commands.executeCommand('evolve.runNet');
    } else {
      await vscode.commands.executeCommand('evolve.debugNet');
    }
  });

  context.subscriptions.push(
    openGraphEditor,
    toggleBpCmd,
    bpListener,
    inscriptionFileSystem,
    openInscriptionCmd,
    openInscriptionAtCursorCmd,
    codeLensProvider,
    runNetCmd,
    debugNetCmd,
    showRunMenuCmd
    // no save listener needed; writeFile handles updates
  );

  const dapFactory = (vscode as any).debug.registerDebugAdapterDescriptorFactory('evolve-pnml', {
    createDebugAdapterDescriptor() {
      const adapterPath = (vscode as any).Uri.file(
        path.join(context.extensionPath, '..', 'enginepy', 'pnml_dap.py')
      );
      return new (vscode as any).DebugAdapterExecutable(pythonCmd, ['-u', adapterPath.fsPath]);
    }
  });
  
  // Register tracker to handle custom requests from Python code
  const dapTrackerFactory = vscode.debug.registerDebugAdapterTrackerFactory('evolve-pnml', {
    createDebugAdapterTracker(session: vscode.DebugSession) {
      return {
        onDidSendMessage: async (message: any) => {
          // Handle custom requests from DAP (initiated by Python code)
          if (message.type === 'event' && message.event === 'customRequest') {
            const body = message.body || {};
            const requestId = body.requestId;
            const requestType = body.type;
            const params = body.params || {};
            
            console.log(`[VSCode Bridge] Received custom request ${requestId}: ${requestType}`);
            
            try {
              let result: any = null;
              
              if (requestType === 'vscode/chat') {
                result = await handleChatRequest(params);
              } else if (requestType === 'vscode/executeCommand') {
                result = await handleExecuteCommand(params);
              } else if (requestType === 'vscode/getChatHistory') {
                result = await handleGetChatHistory(params);
              } else if (requestType === 'vscode/showMessage') {
                result = await handleShowMessage(params);
              } else {
                throw new Error(`Unknown request type: ${requestType}`);
              }
              
              console.log(`[VSCode Bridge] Sending response for request ${requestId}`);
              
              // Send response back to DAP
              session.customRequest('customRequestResponse', {
                requestId,
                success: true,
                result
              }).catch((err: Error) => {
                console.error('Failed to send custom request response:', err);
              });
            } catch (error: any) {
              console.error(`[VSCode Bridge] Error handling request ${requestId}:`, error);
              
              // Send error response back to DAP
              session.customRequest('customRequestResponse', {
                requestId,
                success: false,
                error: error.message || String(error)
              }).catch((err: Error) => {
                console.error('Failed to send error response:', err);
              });
            }
          }
        }
      };
    }
  });
  
  context.subscriptions.push(dapFactory, dapTrackerFactory);
}

async function ensureRunBridge(): Promise<{ [key: string]: string }> {
  if (runBridgeInfo && runBridgeSocketServer && runBridgeServer) {
    return buildRunBridgeEnv(runBridgeInfo);
  }

  const portSetting = vscode.workspace.getConfiguration('evolve').get<number>('runBridge.port', 0) || 0;
  const token = crypto.randomBytes(16).toString('hex');
  const sessionId = crypto.randomBytes(8).toString('hex');

  const server = http.createServer();
  const wss = new WebSocketServer({ server });

  wss.on('connection', (socket: WebSocket, req) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const tokenParam = url.searchParams.get('token') || '';
    const sessionParam = url.searchParams.get('session') || '';
    if (tokenParam !== token || sessionParam !== sessionId) {
      socket.close(1008, 'Unauthorized');
      return;
    }

    socket.on('message', async (data) => {
      let payload: any;
      try {
        payload = JSON.parse(data.toString());
      } catch (err) {
        socket.send(JSON.stringify({ id: null, success: false, error: 'Invalid JSON' }));
        return;
      }
      const requestId = payload?.id;
      const requestType = payload?.type;
      const params = payload?.params || {};

      try {
        let result: any = null;
        if (requestType === 'vscode/chat') {
          result = await handleChatRequest(params);
        } else if (requestType === 'vscode/executeCommand') {
          result = await handleExecuteCommand(params);
        } else if (requestType === 'vscode/getChatHistory') {
          result = await handleGetChatHistory(params);
        } else if (requestType === 'vscode/showMessage') {
          result = await handleShowMessage(params);
        } else {
          throw new Error(`Unknown request type: ${requestType}`);
        }
        socket.send(JSON.stringify({ id: requestId, success: true, result }));
      } catch (error: any) {
        socket.send(JSON.stringify({ id: requestId, success: false, error: error?.message || String(error) }));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(portSetting, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  const addressInfo = server.address();
  const port = typeof addressInfo === 'object' && addressInfo ? addressInfo.port : portSetting;
  const addr = `ws://127.0.0.1:${port}/`;

  runBridgeServer = server;
  runBridgeSocketServer = wss;
  runBridgeInfo = { addr, token, sessionId, port };

  return buildRunBridgeEnv(runBridgeInfo);
}

function buildRunBridgeEnv(info: RunBridgeInfo): { [key: string]: string } {
  return {
    EVOLVE_RUN_BRIDGE_ADDR: info.addr,
    EVOLVE_RUN_BRIDGE_TOKEN: info.token,
    EVOLVE_RUN_BRIDGE_SESSION: info.sessionId
  };
}

/**
 * Select Copilot model using params.model, workspace setting, or fallback to first available model.
 */
export async function selectCopilotModel(params: any): Promise<any> {
  const requested = params && params.model ? String(params.model) : '';

  // Workspace configured model (if any)
  const configured = vscode.workspace.getConfiguration('evolve').get<string>('copilot.defaultModel', '') || '';
  const requestedModelId = requested || configured || '';

  const models = await (vscode as any).lm.selectChatModels({ vendor: 'copilot' });
  if (!Array.isArray(models) || models.length === 0) return null;

  if (requestedModelId) {
    // Exact match on id/name/displayName
    let found = models.find((m: any) => {
      const id = (m.id || m.name || m.displayName || '').toString();
      return id === requestedModelId;
    });
    if (!found) {
      // Fuzzy contains match (case-insensitive)
      const needle = requestedModelId.toLowerCase();
      found = models.find((m: any) => {
        const id = (m.id || m.name || m.displayName || '').toString().toLowerCase();
        return id.includes(needle);
      });
    }
    if (found) {
      console.log('[VSCode Bridge] selected copilot model (configured):', (found.id || found.name || found.displayName || '<unknown>'));
    }
    return found || null;
  }

  console.log('[VSCode Bridge] selected copilot model (auto):', (models[0].id || models[0].name || models[0].displayName || '<unknown>'));
  return models[0];
}

/**
 * Handle chat request from Python code
 */
async function handleChatRequest(params: any): Promise<any> {
  const message = params.message || '';
  const timeout = params.timeout || 30000;
  const conversationId = params.conversationId || `conv-${Date.now()}`;
  const openChatOnBlocked = params.openChatOnBlocked !== false;
  
  if (!message) {
    throw new Error('Missing message parameter');
  }

  const available = await isCopilotAvailable();
  if (!available) {
    throw new Error('Copilot chat model is not available. Make sure GitHub Copilot is enabled and you have access.');
  }

  // Resolve model selection (params.model overrides workspace setting). Uses first available model as fallback.
  const model = await selectCopilotModel(params);
  if (!model) {
    throw new Error('No Copilot chat model found.');
  }

  const history = chatHistory.get(conversationId) || [];
  const messages: any[] = [];

  for (const entry of history) {
    if (entry.role === 'user') {
      messages.push((vscode as any).LanguageModelChatMessage.User(entry.content));
    } else {
      messages.push((vscode as any).LanguageModelChatMessage.Assistant(entry.content));
    }
  }
  messages.push((vscode as any).LanguageModelChatMessage.User(message));

  const tokenSource = new (vscode as any).CancellationTokenSource();
  const timeoutHandle = setTimeout(() => tokenSource.cancel(), timeout);

  try {
    const response = await model.sendRequest(messages, {}, tokenSource.token);
    let text = '';
    for await (const fragment of response.text) {
      text += fragment;
    }

    const normalized = text.trim().toLowerCase();
    const looksBlocked =
      normalized.startsWith("sorry, i can't assist") ||
      normalized.startsWith("sorry, i can’t assist") ||
      normalized.startsWith("sorry, i can't help") ||
      normalized.startsWith("sorry, i can’t help") ||
      normalized.includes("i can only explain computer science") ||
      normalized.includes("off topic");

    if (looksBlocked) {
      if (openChatOnBlocked) {
        try {
          await vscode.commands.executeCommand('workbench.action.chat.open', { query: message });
        } catch {
          // ignore
        }
      }
      return {
        response: '',
        conversationId,
        blocked: true,
        blockedReason: 'refusal',
        openedChat: openChatOnBlocked
      };
    }

    const timestamp = Date.now();
    history.push({ role: 'user', content: message, timestamp });
    history.push({ role: 'assistant', content: text, timestamp: Date.now() });
    chatHistory.set(conversationId, history);

    return { response: text, conversationId };
  } catch (err: any) {
    const code = err?.code || err?.cause?.message || err?.message || '';
    const isOffTopic = String(code).includes('off_topic');
    if (isOffTopic) {
      if (openChatOnBlocked) {
        try {
          await vscode.commands.executeCommand('workbench.action.chat.open', { query: message });
        } catch {
          // ignore
        }
      }
      return {
        response: '',
        conversationId,
        blocked: true,
        blockedReason: 'off_topic',
        openedChat: openChatOnBlocked
      };
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
    tokenSource.dispose();
  }
}

/**
 * Execute VS Code command from Python code
 */
async function handleExecuteCommand(params: any): Promise<any> {
  const command = params.command;
  const args = params.args || [];
  const timeout = params.timeout || 10000;
  
  if (!command) {
    throw new Error('Missing command parameter');
  }
  
  // Execute command with timeout
  const result = await Promise.race([
    vscode.commands.executeCommand(command, ...args),
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Command timeout')), timeout)
    )
  ]);
  
  return { result };
}

/**
 * Get chat history from Python code
 */
async function handleGetChatHistory(params: any): Promise<any> {
  const conversationId = params.conversationId;
  const limit = params.limit || 10;
  
  if (!conversationId) {
    throw new Error('Missing conversationId parameter');
  }

  const history = chatHistory.get(conversationId) || [];
  const sliced = history.slice(-limit);
  return { messages: sliced };
}

/**
 * Show message in VS Code from Python code
 */
async function handleShowMessage(params: any): Promise<any> {
  const message = params.message || '';
  const level = params.level || 'info';
  
  if (!message) {
    throw new Error('Missing message parameter');
  }
  
  switch (level) {
    case 'error':
      vscode.window.showErrorMessage(message);
      break;
    case 'warning':
      vscode.window.showWarningMessage(message);
      break;
    default:
      vscode.window.showInformationMessage(message);
  }
  
  return {};
}


export function deactivate(): Thenable<void> | undefined {
  const stops: Array<Thenable<void>> = [];
  if (yamlClient) {
    stops.push(yamlClient.stop());
  }
  if (!client) {
    if (runBridgeSocketServer) {
      runBridgeSocketServer.close();
      runBridgeSocketServer = undefined;
    }
    if (runBridgeServer) {
      runBridgeServer.close();
      runBridgeServer = undefined;
    }
    runBridgeInfo = undefined;
    return stops.length > 0 ? Promise.all(stops).then(() => undefined) : undefined;
  }
  stops.push(client.stop());
  if (runBridgeSocketServer) {
    runBridgeSocketServer.close();
    runBridgeSocketServer = undefined;
  }
  if (runBridgeServer) {
    runBridgeServer.close();
    runBridgeServer = undefined;
  }
  runBridgeInfo = undefined;
  return Promise.all(stops).then(() => undefined);
}
