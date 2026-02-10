import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";
import * as http from "http";
import * as crypto from "crypto";
import WebSocket, { WebSocketServer } from "ws";
import { PendingOp, PendingOpsStore, PendingOpStatus } from "./pendingOpsStore";
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

type LambdaHandler = (args: unknown[], op: PendingOp) => Promise<unknown> | unknown;

class LambdaRegistry {
  private readonly handlers = new Map<string, LambdaHandler>();

  register(name: string, handler: LambdaHandler): void {
    const key = (name || '').trim();
    if (!key) {
      throw new Error('Lambda handler name is required');
    }
    this.handlers.set(key, handler);
  }

  get(name: string | undefined): LambdaHandler | undefined {
    if (!name) return undefined;
    return this.handlers.get(name);
  }

  clear(): void {
    this.handlers.clear();
  }
}

type RunBridgeInfo = {
  addr: string;
  token: string;
  sessionId: string;
  port: number;
};

type AsyncSubmitPayload = {
  operationId?: string;
  resumeToken?: string;
  result?: unknown;
  error?: string | null;
  source?: string;
};

let runBridgeServer: http.Server | undefined;
let runBridgeSocketServer: WebSocketServer | undefined;
let runBridgeInfo: RunBridgeInfo | undefined;
let pendingOpsStore: PendingOpsStore | undefined;
let pendingStatusBarItem: vscode.StatusBarItem | undefined;
const runBridgeClients = new Set<WebSocket>();
let asyncSubmitHandler: ((payload: AsyncSubmitPayload) => Promise<void>) | undefined;
let selectChatModelsOverride: (() => Promise<any[]>) | undefined;
let lambdaRegistry: LambdaRegistry | undefined;
const lambdaOpsInFlight = new Set<string>();
const completedResumeTokens = new Map<string, PendingOpStatus>();

const getChatModels = async (): Promise<any[]> => {
  if (selectChatModelsOverride) {
    return selectChatModelsOverride();
  }
  return (vscode as any).lm.selectChatModels({ vendor: 'copilot' });
};

const isCopilotAvailable = async (): Promise<boolean> => {
  try {
    const models = await getChatModels();
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

  pendingOpsStore = new PendingOpsStore(context);
  lambdaRegistry = new LambdaRegistry();
  lambdaRegistry.register('score', (args) => {
    const value = Array.isArray(args) ? args[0] : undefined;
    if (typeof value === 'number') {
      return { score: value };
    }
    return { score: value ?? null };
  });

  const updatePendingStatusBar = () => {
    if (!pendingOpsStore) return;
    if (!pendingStatusBarItem) {
      pendingStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
      pendingStatusBarItem.command = 'evolve.listPendingOperations';
      context.subscriptions.push(pendingStatusBarItem);
    }
    const summary = pendingOpsStore.getPendingSummary();
    pendingStatusBarItem.text = `Evolve: Pending (${summary.count})`;
    if (summary.oldestAgeMs) {
      pendingStatusBarItem.tooltip = `Oldest pending: ${formatDuration(summary.oldestAgeMs)}`;
    } else {
      pendingStatusBarItem.tooltip = 'No pending operations.';
    }
    pendingStatusBarItem.show();
  };

  pendingOpsStore.onDidChangePendingOps(async (evt) => {
    updatePendingStatusBar();
    if (evt.type === 'removed' && evt.op.resumeToken) {
      completedResumeTokens.set(evt.op.resumeToken, evt.op.status || 'completed');
      if (completedResumeTokens.size > 1000) {
        const oldest = completedResumeTokens.keys().next();
        if (!oldest.done) completedResumeTokens.delete(oldest.value);
      }
    }
    if (evt.type === 'started') {
      const actions: string[] = ['Open pending list'];
      if (evt.op.operationType === 'form') {
        actions.unshift('Resume form');
      }
      const selection = await vscode.window.showInformationMessage(
        `Pending async operation: ${evt.op.transitionName || evt.op.transitionId || evt.op.operationId}`,
        ...actions
      );
      if (!selection) return;
      if (selection === 'Open pending list') {
        void vscode.commands.executeCommand('evolve.listPendingOperations');
      } else if (selection === 'Resume form') {
        void vscode.commands.executeCommand('evolve.resumeForm', evt.op.operationId);
      }
    }
  });
  updatePendingStatusBar();

  const listPendingCmd = vscode.commands.registerCommand('evolve.listPendingOperations', async () => {
    if (!pendingOpsStore) return;
    const pending = pendingOpsStore.listPending();
    if (pending.length === 0) {
      vscode.window.showInformationMessage('No pending operations.');
      return;
    }
    const items = pending.map((op) => ({
      label: op.transitionName || op.transitionId || op.operationId,
      description: `run ${op.runId || '-'} · ${op.operationType || 'async'}`,
      detail: formatPendingDetail(op),
      op
    }));
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a pending operation'
    });
    if (!pick) return;
    const actions = ['Submit', 'Cancel'];
    if (pick.op.operationType === 'form') {
      actions.unshift('Resume form');
    }
    const action = await vscode.window.showQuickPick(actions, {
      placeHolder: 'Select action'
    });
    if (!action) return;
    if (action === 'Resume form') {
      await vscode.commands.executeCommand('evolve.resumeForm', pick.op.operationId);
    } else if (action === 'Cancel') {
      await vscode.commands.executeCommand('evolve.cancelOperation', pick.op.operationId);
    } else {
      await vscode.commands.executeCommand('evolve.submitOperation', pick.op.operationId);
    }
  });

  const resumeFormCmd = vscode.commands.registerCommand('evolve.resumeForm', async (operationId?: string) => {
    if (!pendingOpsStore) return;
    const op = resolvePendingOperation(pendingOpsStore, operationId);
    if (!op) return;
    const result = await promptForResult(op, 'Enter form response (JSON or text)');
    if (result === undefined) return;
    await submitOperation(op, { result, source: 'form' });
  });

  const cancelOpCmd = vscode.commands.registerCommand('evolve.cancelOperation', async (operationId?: string) => {
    if (!pendingOpsStore) return;
    const op = resolvePendingOperation(pendingOpsStore, operationId);
    if (!op) return;
    await submitOperation(op, { error: 'cancelled', source: 'cancel' });
    pendingOpsStore.markCancelled(op.operationId, 'cancelled');
  });

  const submitOpCmd = vscode.commands.registerCommand('evolve.submitOperation', async (operationId?: string, result?: unknown) => {
    if (!pendingOpsStore) return;
    const op = resolvePendingOperation(pendingOpsStore, operationId);
    if (!op) return;
    let resolved = result;
    if (resolved === undefined) {
      resolved = await promptForResult(op, 'Enter submit result (JSON or text)');
    }
    if (resolved === undefined) return;
    await submitOperation(op, { result: resolved, source: 'manual' });
  });

  context.subscriptions.push(listPendingCmd, resumeFormCmd, cancelOpCmd, submitOpCmd);

  const chat = (vscode as any).chat;
  if (chat && typeof chat.createChatParticipant === 'function') {
    const participant = chat.createChatParticipant('evolve', async (request: any, chatContext: any, stream: any) => {
      const response = await handleSlashCommand(request, chatContext);
      if (stream?.markdown) {
        stream.markdown(response);
      } else if (stream?.appendText) {
        stream.appendText(response);
      }
    });
    participant.commands = [
      { name: 'jobs', description: 'List pending async operations' },
      { name: 'submit', description: 'Submit a pending operation by resume token' }
    ];
    participant.description = 'EVOLVE async operations';
    context.subscriptions.push(participant);
  }

  const openGraphEditor = vscode.commands.registerCommand(
    "evolve.openGraphEditor",
    () => {
      vscode.window.showInformationMessage(
        "EVOLVE Graph Editor will open here once the webview is implemented."
      );
    }
  );

  const getSchemaCmd = vscode.commands.registerCommand('evolve.getPnmlSchema', async () => {
    const schemaText = await readTextFile(schemaPath);
    return { schema: schemaText };
  });

  const generateMermaidCmd = vscode.commands.registerCommand('evolve.generateMermaidFromPnml', async (uri?: vscode.Uri) => {
    const doc = await resolvePnmlDocument(uri);
    if (!doc) {
      vscode.window.showInformationMessage('No PNML/YAML file selected.');
      return;
    }
    const pnmlText = doc.getText();
    if (!pnmlText.trim()) {
      vscode.window.showInformationMessage('The PNML file is empty.');
      return;
    }

    const available = await isCopilotAvailable();
    if (!available) {
      vscode.window.showErrorMessage('Copilot chat model is not available.');
      return;
    }

    const model = await selectCopilotModel({});
    if (!model) {
      vscode.window.showErrorMessage('No Copilot chat model found.');
      return;
    }

    const systemPrompt = await loadMermaidSystemPrompt(context);
    const userPrompt = buildMermaidUserPrompt(pnmlText);
    const messages: any[] = [];
    const lm = (vscode as any).LanguageModelChatMessage;
    if (lm?.System) {
      messages.push(lm.System(systemPrompt));
    } else {
      messages.push(lm.User(`System prompt:\n${systemPrompt}`));
    }
    messages.push(lm.User(userPrompt));

    const tokenSource = new (vscode as any).CancellationTokenSource();
    try {
      const response = await model.sendRequest(messages, {}, tokenSource.token);
      let text = '';
      for await (const fragment of response.text) {
        text += fragment;
      }
      const output = normalizeMermaidOutput(text);
      // Open as a named untitled Markdown document so it is visible and easy to save.
      const base = path.basename(doc.uri.fsPath, path.extname(doc.uri.fsPath));
      const untitledName = `${base}.diagram.md`;
      const outUri = vscode.Uri.parse(`untitled:${untitledName}`);
      let outDoc: vscode.TextDocument;
      try {
        // Create named untitled doc and insert content so the tab shows the filename
        outDoc = await vscode.workspace.openTextDocument(outUri);
        const edit = new (vscode as any).WorkspaceEdit();
        edit.insert(outUri, new (vscode as any).Position(0, 0), output);
        await vscode.workspace.applyEdit(edit);
      } catch (err) {
        // Fallback to untitled content-based doc
        outDoc = await vscode.workspace.openTextDocument({ content: output, language: 'markdown' });
      }
      await vscode.window.showTextDocument(outDoc, { preview: false });
    } catch (err: any) {
      vscode.window.showErrorMessage(`Mermaid generation failed: ${err?.message || String(err)}`);
    } finally {
      tokenSource.dispose();
    }
  });

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

    // Honor the preserveRunDirs setting: add EVOLVE_PRESERVE_RUNS to run environment
    const preserve = vscode.workspace.getConfiguration('evolve').get<boolean>('preserveRunDirs', false);
    if (preserve) {
      runBridgeEnv = { ...runBridgeEnv, EVOLVE_PRESERVE_RUNS: '1' };
    }
    if (client) {
      try {
        await client.sendRequest('workspace/executeCommand', { command: 'evolve.setPreserveRunDirs', arguments: [{ preserve }] });
      } catch (err) {
        console.warn('Failed to notify LSP of preserve setting before run:', err);
      }
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

    // Propagate preserve setting into debug env so debug runs also preserve dirs when enabled
    const preserve = vscode.workspace.getConfiguration('evolve').get<boolean>('preserveRunDirs', false);
    let env: { [key: string]: string } | undefined = undefined;
    if (preserve) {
      env = { EVOLVE_PRESERVE_RUNS: '1' };
    }

    if (client) {
      // Notify LSP server about preserve setting so runtime.run_in_venv honors it
      try {
        await client.sendRequest('workspace/executeCommand', { command: 'evolve.setPreserveRunDirs', arguments: [{ preserve }] });
      } catch (err) {
        console.warn('Failed to notify LSP of preserve setting before debug:', err);
      }

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
      program: editor.document.uri.fsPath,
      env
    });
  });

  const showRunMenuCmd = vscode.commands.registerCommand('evolve.showRunMenu', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !allowedBreakpointFile(editor.document.uri)) {
      vscode.window.showInformationMessage('Open a *.pnml.yaml or *.evolve.yaml file to run.');
      return;
    }
    const preserve = vscode.workspace.getConfiguration('evolve').get<boolean>('preserveRunDirs', false);
    const pick = await vscode.window.showQuickPick(
      [
        { label: '$(play) Run EVOLVE PNML', id: 'run' },
        { label: '$(debug-alt) Debug EVOLVE PNML', id: 'debug' },
        { label: `${preserve ? '$(check) ' : ''}Keep run dirs`, id: 'togglePreserve' }
      ],
      { placeHolder: 'Select action' }
    );
    if (!pick) return;
    if (pick.id === 'run') {
      await vscode.commands.executeCommand('evolve.runNet');
    } else if (pick.id === 'debug') {
      await vscode.commands.executeCommand('evolve.debugNet');
    } else if (pick.id === 'togglePreserve') {
      await vscode.commands.executeCommand('evolve.togglePreserveRunDirs');
    }
    if (!pick) return;
    if (pick.id === 'run') {
      await vscode.commands.executeCommand('evolve.runNet');
    } else {
      await vscode.commands.executeCommand('evolve.debugNet');
    }
  });

  const togglePreserveCmd = vscode.commands.registerCommand('evolve.togglePreserveRunDirs', async () => {
    const cfg = vscode.workspace.getConfiguration('evolve');
    const cur = cfg.get<boolean>('preserveRunDirs', false);
    const next = !cur;
    await cfg.update('preserveRunDirs', next, vscode.ConfigurationTarget.Global);
    // Inform the language server so long-running Python process honors the setting
    if (client) {
      try {
        await client.sendRequest('workspace/executeCommand', { command: 'evolve.setPreserveRunDirs', arguments: [{ preserve: next }] });
      } catch (err) {
        console.warn('Failed to notify LSP of preserve setting:', err);
      }
    }
    vscode.window.showInformationMessage(`EVOLVE: Keep run dirs ${next ? 'enabled' : 'disabled'}`);
  });

  context.subscriptions.push(
    openGraphEditor,
    getSchemaCmd,
    generateMermaidCmd,
    toggleBpCmd,
    bpListener,
    inscriptionFileSystem,
    openInscriptionCmd,
    openInscriptionAtCursorCmd,
    codeLensProvider,
    runNetCmd,
    debugNetCmd,
    showRunMenuCmd,
    togglePreserveCmd
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
          if (message.type === 'event' && (message.event === 'asyncOperationStarted' || message.event === 'asyncOperationUpdated')) {
            handleAsyncOperationEvent(message.event, message.body || {});
            return;
          }
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
              }).then(undefined, (err: Error) => {
                console.error('Failed to send custom request response:', err);
              });
            } catch (error: any) {
              console.error(`[VSCode Bridge] Error handling request ${requestId}:`, error);
              
              // Send error response back to DAP
              session.customRequest('customRequestResponse', {
                requestId,
                success: false,
                error: error.message || String(error)
              }).then(undefined, (err: Error) => {
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

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function resolveOperationParams(op: PendingOp): Record<string, unknown> | undefined {
  const direct = op.operationParams || undefined;
  if (direct && typeof direct === 'object') return direct as Record<string, unknown>;
  const metadataParams = op.metadata && (op.metadata as Record<string, unknown>).operationParams;
  if (metadataParams && typeof metadataParams === 'object') {
    return metadataParams as Record<string, unknown>;
  }
  return undefined;
}

async function runLambdaOperation(op: PendingOp): Promise<void> {
  if (!lambdaRegistry) return;
  if (lambdaOpsInFlight.has(op.operationId)) return;
  const params = resolveOperationParams(op) || {};
  const name = typeof params.name === 'string' ? params.name : undefined;
  const args = Array.isArray((params as any).args) ? (params as any).args : [];
  const handler = lambdaRegistry.get(name);
  if (!handler) {
    await submitOperation(op, { error: `Unknown lambda handler: ${name || 'unknown'}`, source: 'lambda' });
    return;
  }
  lambdaOpsInFlight.add(op.operationId);
  try {
    const result = await Promise.resolve(handler(args, op));
    await submitOperation(op, { result, source: 'lambda' });
  } catch (err: any) {
    const message = err?.message || String(err);
    await submitOperation(op, { error: message, source: 'lambda' });
  } finally {
    lambdaOpsInFlight.delete(op.operationId);
  }
}

function formatPendingDetail(op: PendingOp): string {
  const parts: string[] = [];
  if (op.resumeToken) parts.push(`token: ${op.resumeToken}`);
  const params = resolveOperationParams(op);
  if (op.operationType === 'lambda') {
    const name = typeof params?.name === 'string' ? params?.name : 'unknown';
    const args = Array.isArray((params as any)?.args) ? (params as any).args : [];
    parts.push(`lambda: ${name}(${args.length})`);
  } else if (op.operationType === 'http_endpoint') {
    const method = typeof params?.method === 'string' ? params.method : 'POST';
    const url = typeof params?.url === 'string' ? params.url : '';
    parts.push(`http: ${method}${url ? ' ' + url : ''}`);
  }
  if (op.runId) parts.push(`run: ${op.runId}`);
  if (op.timeoutMs) {
    const remaining = Math.max(0, op.timeoutMs - (Date.now() - op.createdAt));
    parts.push(`remaining: ${formatDuration(remaining)}`);
  }
  return parts.join(' · ');
}

function resolvePendingOperation(store: PendingOpsStore, operationId?: string): PendingOp | undefined {
  if (operationId) {
    const op = store.findById(String(operationId));
    if (!op) {
      vscode.window.showWarningMessage('Pending operation not found.');
    }
    return op;
  }
  const pending = store.listPending();
  if (pending.length === 1) return pending[0];
  if (pending.length === 0) {
    vscode.window.showInformationMessage('No pending operations.');
    return undefined;
  }
  vscode.window.showInformationMessage('Multiple pending operations found. Use the pending list to select one.');
  return undefined;
}

async function promptForResult(op: PendingOp, prompt: string): Promise<unknown | undefined> {
  const input = await vscode.window.showInputBox({
    prompt,
    placeHolder: op.resumeToken ? `Token: ${op.resumeToken}` : undefined
  });
  if (input === undefined) return undefined;
  if (!input) return '';
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

async function submitOperation(op: PendingOp, payload: AsyncSubmitPayload): Promise<void> {
  const submitPayload: AsyncSubmitPayload = {
    operationId: op.operationId,
    resumeToken: op.resumeToken,
    result: payload.result,
    error: payload.error ?? null,
    source: payload.source
  };
  if (asyncSubmitHandler) {
    await asyncSubmitHandler(submitPayload);
  } else {
    await sendAsyncSubmit(submitPayload);
  }
  if (pendingOpsStore && op.status === 'pending') {
    if (submitPayload.error) {
      pendingOpsStore.markFailed(op.operationId, submitPayload.error || 'failed');
    } else {
      pendingOpsStore.markCompleted(op.operationId, submitPayload.result);
    }
  }
}

async function sendAsyncSubmit(payload: AsyncSubmitPayload): Promise<void> {
  const active = vscode.debug.activeDebugSession;
  if (active && active.type === 'evolve-pnml') {
    await active.customRequest('asyncOperationSubmit', {
      operationId: payload.operationId,
      resumeToken: payload.resumeToken,
      result: payload.result,
      error: payload.error
    });
    return;
  }
  if (runBridgeClients.size > 0) {
    const message = JSON.stringify({
      type: 'dapEvent',
      event: 'asyncOperationSubmit',
      body: {
        operationId: payload.operationId,
        resumeToken: payload.resumeToken,
        result: payload.result,
        error: payload.error
      }
    });
    for (const client of runBridgeClients) {
      client.send(message);
    }
  }
}

function handleAsyncOperationEvent(eventName: string, body: any): void {
  if (!pendingOpsStore) return;
  if (eventName === 'asyncOperationStarted') {
    const createdAt = Number(body?.createdAt || Date.now());
    const timeoutMsRaw =
      body?.timeoutMs ||
      body?.metadata?.timeout ||
      body?.metadata?.timeoutMs ||
      body?.metadata?.timeout_ms;
    const timeoutMs = typeof timeoutMsRaw === 'number' ? timeoutMsRaw : Number(timeoutMsRaw || 0) || undefined;
    const op: PendingOp = {
      operationId: String(body?.operationId ?? body?.id ?? ''),
      transitionId: body?.transitionId,
      transitionName: body?.transitionName,
      transitionDescription: body?.transitionDescription,
      inscriptionId: body?.inscriptionId,
      netId: body?.netId,
      runId: body?.runId,
      operationType: body?.operationType,
      operationParams: body?.operationParams || body?.metadata?.operationParams,
      status: 'pending',
      resumeToken: body?.resumeToken,
      uiState: body?.uiState,
      metadata: body?.metadata,
      createdAt,
      timeoutMs
    };
    if (!op.operationId) return;
    pendingOpsStore.registerStarted(op);
    if (String(op.operationType || '').toLowerCase() === 'lambda') {
      void runLambdaOperation(op);
    }
    return;
  }
  if (eventName === 'asyncOperationUpdated') {
    const opId = String(body?.operationId ?? body?.id ?? '');
    if (!opId) return;
    const status = String(body?.status || 'pending') as any;
    pendingOpsStore.updateStatus(opId, status, body?.result, body?.error);
  }
}

function renderJobsList(pending: PendingOp[]): string {
  if (pending.length === 0) {
    return 'No pending operations.';
  }
  const lines = pending.map((op) => {
    const remaining = op.timeoutMs ? Math.max(0, op.timeoutMs - (Date.now() - op.createdAt)) : undefined;
    const remainingText = remaining !== undefined ? formatDuration(remaining) : 'n/a';
    const params = resolveOperationParams(op);
    let typeDetail = op.operationType || 'async';
    if (op.operationType === 'lambda') {
      const name = typeof params?.name === 'string' ? params.name : 'unknown';
      typeDetail = `lambda:${name}`;
    } else if (op.operationType === 'http_endpoint') {
      const method = typeof params?.method === 'string' ? params.method : 'POST';
      const url = typeof params?.url === 'string' ? params.url : '';
      typeDetail = `http:${method}${url ? ' ' + url : ''}`;
    }
    return [
      `• ${op.transitionName || op.transitionId || op.operationId}`,
      `  type: ${typeDetail}`,
      `  token: ${op.resumeToken || 'n/a'}`,
      `  run: ${op.runId || 'n/a'} · net: ${op.netId || 'n/a'}`,
      `  timeout: ${remainingText}`
    ].join('\n');
  });
  return lines.join('\n');
}

async function handleSlashCommand(request: any, chatContext: any): Promise<string> {
  if (!pendingOpsStore) {
    return 'Pending operations store is not available.';
  }
  const available = await isCopilotAvailable();
  if (!available) {
    const summary = pendingOpsStore.getPendingSummary();
    return `Copilot models unavailable. Check status bar: Evolve: Pending (${summary.count}).`;
  }
  const command = request?.command || '';
  const prompt = (request?.prompt || request?.message || request?.text || '').toString().trim();
  if (command === 'jobs') {
    return renderJobsList(pendingOpsStore.listPending());
  }
  if (command === 'submit') {
    const [token, ...rest] = prompt.split(/\s+/);
    if (!token) {
      return 'Usage: /submit <token> <message>';
    }
    const op = pendingOpsStore.findByToken(token);
    if (!op) {
      return `Invalid resume token: ${token}`;
    }
    const message = rest.join(' ').trim();
    const result = {
      message,
      participantContext: {
        workspace: vscode.workspace.name,
        chatContext: chatContext || null
      }
    };
    await submitOperation(op, { result, source: 'copilot' });
    return `Submitted result for ${op.transitionName || op.operationId}.`;
  }
  return 'Supported commands: /jobs, /submit <token> <message>';
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

  server.on('request', (req, res) => {
    if (!req.url) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'POST' || url.pathname !== '/submit') {
      res.statusCode = 404;
      res.end();
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', async () => {
      let payload: any;
      try {
        payload = body ? JSON.parse(body) : {};
      } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }
      const headerToken = (req.headers['x-evolve-run-bridge-token'] || req.headers['x-evolve-token'] || '').toString();
      const authHeader = (req.headers['authorization'] || '').toString();
      const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : '';
      const providedToken = headerToken || bearer;
      if (!providedToken || providedToken !== token) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      const headerSession = (req.headers['x-evolve-run-bridge-session'] || req.headers['x-evolve-session'] || '').toString();
      const querySession = url.searchParams.get('session') || '';
      const payloadSession = payload?.sessionId || payload?.session || '';
      const providedSession = headerSession || querySession || String(payloadSession || '');
      if (!providedSession || providedSession !== sessionId) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'Unauthorized session' }));
        return;
      }
      const resumeToken = payload?.resumeToken;
      const result = payload?.result;
      if (!resumeToken) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'Missing resumeToken' }));
        return;
      }
      if (!pendingOpsStore) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: 'Pending operations store not available' }));
        return;
      }
      const op = pendingOpsStore.findByToken(resumeToken);
      if (!op) {
        if (completedResumeTokens.has(resumeToken)) {
          res.statusCode = 409;
          res.end(JSON.stringify({ error: 'Operation already completed' }));
        } else {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'Unknown resumeToken' }));
        }
        return;
      }
      if (op.status !== 'pending') {
        res.statusCode = 409;
        res.end(JSON.stringify({ error: 'Operation already completed' }));
        return;
      }
      await submitOperation(op, { result, source: 'http' });
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, operationId: op.operationId }));
    });
  });

  wss.on('connection', (socket: WebSocket, req) => {
    runBridgeClients.add(socket);
    const url = new URL(req.url || '/', 'http://localhost');
    const tokenParam = url.searchParams.get('token') || '';
    const sessionParam = url.searchParams.get('session') || '';
    if (tokenParam !== token || sessionParam !== sessionId) {
      socket.close(1008, 'Unauthorized');
      runBridgeClients.delete(socket);
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
      if (payload?.type === 'dapEvent' && payload?.event) {
        handleAsyncOperationEvent(payload.event, payload.body || {});
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

    socket.on('close', () => {
      runBridgeClients.delete(socket);
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

  const models = await getChatModels();
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
  const openChatOnBlocked = false;
  
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

async function readTextFile(filePath: string): Promise<string> {
  return await fs.promises.readFile(filePath, 'utf8');
}

function isPnmlFile(uri: vscode.Uri | undefined): boolean {
  if (!uri) return false;
  const rawPath = (uri.fsPath || uri.path || '').toString().toLowerCase();
  return rawPath.endsWith('.pnml.yaml') || rawPath.endsWith('.evolve.yaml');
}

async function resolvePnmlDocument(uri?: vscode.Uri): Promise<vscode.TextDocument | undefined> {
  if (uri && isPnmlFile(uri)) {
    return await vscode.workspace.openTextDocument(uri);
  }
  const editor = vscode.window.activeTextEditor;
  if (editor && isPnmlFile(editor.document.uri)) {
    return editor.document;
  }
  return undefined;
}

async function loadMermaidSystemPrompt(context: vscode.ExtensionContext): Promise<string> {
  const fallback = [
    'You are a Petri Net visualization assistant. Given PNML YAML input, generate a Mermaid flowchart that represents the Petri Net structure.',
    '',
    'Rules:',
    '1. Places are rendered as ([place_id]) (stadium shape = circle).',
    '2. Transitions are rendered as [transition_id] (rectangle).',
    '3. Arcs connect places to transitions or transitions to places.',
    '4. Use subgraph to group the net with a descriptive title.',
    '5. Add a legend comment explaining the notation.',
    '6. Wrap all labels in double quotes and use <br> instead of \\n inside the quoted string to indicate line breaks and escape any double quotes inside a label with \\\" to prevent Mermaid parse errors.',
    '',
    'Output format:',
    '```mermaid',
    'flowchart LR',
    '  subgraph NetName["Net Title"]',
    '    %% Places: ([id]) = circle',
    '    %% Transitions: [id] = rectangle',
    '  end',
    '```'
  ].join('\n');

  const kbPath = path.join(context.extensionPath, '..', 'kb', 'guide', 'AgenticFlow.md');
  try {
    const content = await readTextFile(kbPath);
    const section = extractPromptSection(content, '## Prompt: PNML YAML to Mermaid Petri Net Diagram');
    return section || fallback;
  } catch {
    return fallback;
  }
}

function extractPromptSection(content: string, heading: string): string {
  const start = content.indexOf(heading);
  if (start < 0) return '';
  const rest = content.slice(start + heading.length);
  const nextHeading = rest.search(/\n##\s+/);
  const section = nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
  return `${heading}\n${section}`.trim();
}

function buildMermaidUserPrompt(pnmlText: string): string {
  return [
    'Generate the Mermaid diagram for this PNML YAML. Follow the system rules exactly and output only the Mermaid diagram.',
    '',
    'PNML YAML:',
    '```yaml',
    pnmlText,
    '```'
  ].join('\n');
}

function normalizeMermaidOutput(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  if (trimmed.includes('```mermaid')) return trimmed;
  return ['```mermaid', trimmed, '```'].join('\n');
}

export function __getPendingOpsStore(): PendingOpsStore | undefined {
  return pendingOpsStore;
}

export function __getPendingStatusText(): string | undefined {
  return pendingStatusBarItem?.text;
}

export function __setAsyncSubmitHandler(handler?: (payload: AsyncSubmitPayload) => Promise<void>): void {
  asyncSubmitHandler = handler;
}

export function __setChatModelsOverride(factory?: () => Promise<any[]>): void {
  selectChatModelsOverride = factory;
}

export async function __handleSlashCommandForTests(command: string, prompt: string): Promise<string> {
  return handleSlashCommand({ command, prompt }, null);
}

export function __getLambdaRegistryForTests(): LambdaRegistry | undefined {
  return lambdaRegistry;
}

export async function __ensureRunBridgeForTests(): Promise<RunBridgeInfo> {
  await ensureRunBridge();
  if (!runBridgeInfo) {
    throw new Error('Run bridge not available');
  }
  return runBridgeInfo;
}

export function __shutdownRunBridgeForTests(): void {
  if (runBridgeSocketServer) {
    runBridgeSocketServer.close();
    runBridgeSocketServer = undefined;
  }
  if (runBridgeServer) {
    runBridgeServer.close();
    runBridgeServer = undefined;
  }
  runBridgeInfo = undefined;
}

export function __handleAsyncOperationEventForTests(eventName: string, body: any): void {
  handleAsyncOperationEvent(eventName, body);
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
