"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.selectCopilotModel = selectCopilotModel;
exports.__getPendingOpsStore = __getPendingOpsStore;
exports.__getPendingStatusText = __getPendingStatusText;
exports.__setAsyncSubmitHandler = __setAsyncSubmitHandler;
exports.__handleSlashCommandForTests = __handleSlashCommandForTests;
exports.deactivate = deactivate;
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const http = __importStar(require("http"));
const crypto = __importStar(require("crypto"));
const ws_1 = require("ws");
const pendingOpsStore_1 = require("./pendingOpsStore");
const inscripted_1 = require("./inscripted");
const placeIndex_1 = require("./placeIndex");
const node_1 = require("vscode-languageclient/node");
let client;
let yamlClient;
const generatedModules = new Map();
const chatHistory = new Map();
let runBridgeServer;
let runBridgeSocketServer;
let runBridgeInfo;
let pendingOpsStore;
let pendingStatusBarItem;
const runBridgeClients = new Set();
let asyncSubmitHandler;
const isCopilotAvailable = async () => {
    try {
        const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
        return Array.isArray(models) && models.length > 0;
    }
    catch {
        return false;
    }
};
function activate(context) {
    const schemaPath = path.join(context.extensionPath, '..', 'schema', 'pnml.schema');
    const schemaUri = vscode.Uri.file(schemaPath).toString();
    const schemaPatterns = ['**/*.pnml.yaml', '**/*.evolve.yaml'];
    const yamlServerModule = (() => {
        try {
            return require.resolve("yaml-language-server/bin/yaml-language-server");
        }
        catch {
            return undefined;
        }
    })();
    if (yamlServerModule) {
        const yamlServerOptions = {
            run: { command: process.execPath, args: [yamlServerModule, "--stdio"] },
            debug: { command: process.execPath,
                args: [yamlServerModule, "--stdio", "--log-level", "debug", "--inspect=6009", "--nolazy"]
            }
        };
        const yamlClientOptions = {
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
        yamlClient = new node_1.LanguageClient("evolveYamlBaseLsp", "EVOLVE YAML Language Server", yamlServerOptions, yamlClientOptions);
        // LanguageClient.start() returns a Thenable<void>. Push a disposable that stops the client when disposed.
        yamlClient.start().then(() => {
            context.subscriptions.push({ dispose: () => yamlClient && yamlClient.stop() });
        });
    }
    const pythonCmd = process.env.PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3');
    const serverModule = path.join(context.extensionPath, "..", "ls", "server.py");
    const serverOptions = {
        run: {
            command: pythonCmd,
            args: ["-u", serverModule],
            transport: node_1.TransportKind.stdio
        },
        debug: {
            command: pythonCmd,
            args: ["-u", serverModule],
            transport: node_1.TransportKind.stdio
        }
    };
    const clientOptions = {
        documentSelector: [
            { language: "yaml", pattern: "**/*.pnml.yaml" },
            { language: "yaml", pattern: "**/*.evolve.yaml" }
        ],
        synchronize: {
            fileEvents: vscode.workspace.createFileSystemWatcher("**/*.{pnml.yaml,evolve.yaml}")
        }
    };
    client = new node_1.LanguageClient("evolveHlpnLsp", "EVOLVE HLPN Language Server", serverOptions, clientOptions);
    // LanguageClient.start() returns a Thenable<void>. Push a disposable that stops the client when disposed.
    client.start().then(() => {
        context.subscriptions.push({ dispose: () => client && client.stop() });
    });
    pendingOpsStore = new pendingOpsStore_1.PendingOpsStore(context);
    const updatePendingStatusBar = () => {
        if (!pendingOpsStore)
            return;
        if (!pendingStatusBarItem) {
            pendingStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
            pendingStatusBarItem.command = 'evolve.listPendingOperations';
            context.subscriptions.push(pendingStatusBarItem);
        }
        const summary = pendingOpsStore.getPendingSummary();
        pendingStatusBarItem.text = `Evolve: Pending (${summary.count})`;
        if (summary.oldestAgeMs) {
            pendingStatusBarItem.tooltip = `Oldest pending: ${formatDuration(summary.oldestAgeMs)}`;
        }
        else {
            pendingStatusBarItem.tooltip = 'No pending operations.';
        }
        pendingStatusBarItem.show();
    };
    pendingOpsStore.onDidChangePendingOps(async (evt) => {
        updatePendingStatusBar();
        if (evt.type === 'started') {
            const actions = ['Open pending list'];
            if (evt.op.operationType === 'form') {
                actions.unshift('Resume form');
            }
            const selection = await vscode.window.showInformationMessage(`Pending async operation: ${evt.op.transitionName || evt.op.transitionId || evt.op.operationId}`, ...actions);
            if (!selection)
                return;
            if (selection === 'Open pending list') {
                void vscode.commands.executeCommand('evolve.listPendingOperations');
            }
            else if (selection === 'Resume form') {
                void vscode.commands.executeCommand('evolve.resumeForm', evt.op.operationId);
            }
        }
    });
    updatePendingStatusBar();
    const listPendingCmd = vscode.commands.registerCommand('evolve.listPendingOperations', async () => {
        if (!pendingOpsStore)
            return;
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
        if (!pick)
            return;
        const actions = ['Submit', 'Cancel'];
        if (pick.op.operationType === 'form') {
            actions.unshift('Resume form');
        }
        const action = await vscode.window.showQuickPick(actions, {
            placeHolder: 'Select action'
        });
        if (!action)
            return;
        if (action === 'Resume form') {
            await vscode.commands.executeCommand('evolve.resumeForm', pick.op.operationId);
        }
        else if (action === 'Cancel') {
            await vscode.commands.executeCommand('evolve.cancelOperation', pick.op.operationId);
        }
        else {
            await vscode.commands.executeCommand('evolve.submitOperation', pick.op.operationId);
        }
    });
    const resumeFormCmd = vscode.commands.registerCommand('evolve.resumeForm', async (operationId) => {
        if (!pendingOpsStore)
            return;
        const op = resolvePendingOperation(pendingOpsStore, operationId);
        if (!op)
            return;
        const result = await promptForResult(op, 'Enter form response (JSON or text)');
        if (result === undefined)
            return;
        await submitOperation(op, { result, source: 'form' });
    });
    const cancelOpCmd = vscode.commands.registerCommand('evolve.cancelOperation', async (operationId) => {
        if (!pendingOpsStore)
            return;
        const op = resolvePendingOperation(pendingOpsStore, operationId);
        if (!op)
            return;
        await submitOperation(op, { error: 'cancelled', source: 'cancel' });
        pendingOpsStore.markCancelled(op.operationId, 'cancelled');
    });
    const submitOpCmd = vscode.commands.registerCommand('evolve.submitOperation', async (operationId, result) => {
        if (!pendingOpsStore)
            return;
        const op = resolvePendingOperation(pendingOpsStore, operationId);
        if (!op)
            return;
        let resolved = result;
        if (resolved === undefined) {
            resolved = await promptForResult(op, 'Enter submit result (JSON or text)');
        }
        if (resolved === undefined)
            return;
        await submitOperation(op, { result: resolved, source: 'manual' });
    });
    context.subscriptions.push(listPendingCmd, resumeFormCmd, cancelOpCmd, submitOpCmd);
    const chat = vscode.chat;
    if (chat && typeof chat.createChatParticipant === 'function') {
        const participant = chat.createChatParticipant('evolve', async (request, chatContext, stream) => {
            const response = await handleSlashCommand(request, chatContext);
            if (stream?.markdown) {
                stream.markdown(response);
            }
            else if (stream?.appendText) {
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
    const openGraphEditor = vscode.commands.registerCommand("evolve.openGraphEditor", () => {
        vscode.window.showInformationMessage("EVOLVE Graph Editor will open here once the webview is implemented.");
    });
    // Command to toggle a breakpoint at the current cursor line. Restricted to .pnml.yaml and .evolve.yaml files.
    const allowedBreakpointFile = (uri) => {
        if (!uri)
            return false;
        if (uri.scheme === 'evolve-inscription')
            return true;
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
                vscode.window.showInformationMessage("Breakpoints are only supported in EVOLVE files (*.pnml.yaml, *.evolve.yaml).");
                notifiedBreakpointLimit = true;
            }
            return;
        }
        // Toggle by delegating to built-in command when allowed
        await vscode.commands.executeCommand('editor.debug.action.toggleBreakpoint');
    });
    // Listen for breakpoints added in the workspace and remap to place.id lines when needed.
    let adjustingBreakpoints = false;
    const bpListener = vscode.debug.onDidChangeBreakpoints((ev) => {
        if (adjustingBreakpoints)
            return;
        adjustingBreakpoints = true;
        (async () => {
            const toRemove = [];
            const toAdd = [];
            // Handle removed breakpoints - sync removal between YAML and Python
            for (const bp of ev.removed) {
                const location = bp && bp.location;
                const uri = location && location.uri;
                if (!uri)
                    continue;
                const rawPath = (uri.fsPath || uri.path || '').toString();
                const normalizedPath = rawPath.replace(/\\/g, '/').toLowerCase();
                // If removed from inscriptions.py, find and remove from YAML
                if (normalizedPath.includes('/.vscode/evolve_py/') && normalizedPath.endsWith('/inscriptions.py')) {
                    const yamlUri = Array.from(generatedModules.entries()).find(([_, dir]) => normalizedPath.includes(dir.replace(/\\/g, '/').toLowerCase()))?.[0];
                    if (yamlUri) {
                        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(yamlUri));
                        const line = location.range.start.line;
                        const inscriptions = (0, inscripted_1.extractInscriptions)(doc.getText());
                        const map = buildGeneratedInscriptionLineMap(doc.getText());
                        for (const ins of inscriptions) {
                            const entry = map.get(ins.index);
                            if (entry && line >= entry.codeStartLine && line < entry.codeStartLine + entry.codeLineCount) {
                                if (ins.range) {
                                    const yamlLine = ins.range.start + (line - entry.codeStartLine);
                                    const yamlPos = new vscode.Position(yamlLine, 0);
                                    const yamlLoc = new vscode.Location(vscode.Uri.parse(yamlUri), yamlPos);
                                    const yamlBps = vscode.debug.breakpoints.filter((b) => b.location && b.location.uri.toString() === yamlUri &&
                                        b.location.range.start.line === yamlLine);
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
                                    const pyBps = vscode.debug.breakpoints.filter((b) => b.location && b.location.uri.fsPath === targetUri.fsPath &&
                                        b.location.range.start.line === targetLine);
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
                const doc = await vscode.workspace.openTextDocument(uri);
                const line = location.range.start.line;
                if (isInInscriptionCode(doc.getText(), line)) {
                    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                    let moduleDir = generatedModules.get(uri.toString()) || '';
                    if (!moduleDir && client) {
                        const result = await client.sendRequest('workspace/executeCommand', {
                            command: 'evolve.generatePython',
                            arguments: [{ uri: uri.toString(), workspaceRoot }]
                        });
                        moduleDir = (result && result.moduleDir) || '';
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
                            const pos = new vscode.Position(targetLine, 0);
                            const loc = new vscode.Location(targetUri, pos);
                            toAdd.push(new vscode.SourceBreakpoint(loc, true));
                            toAdd.push(new vscode.SourceBreakpoint(location, true));
                            continue;
                        }
                    }
                    continue;
                }
                const places = (0, placeIndex_1.extractPlaceIndex)(doc.getText());
                const place = (0, placeIndex_1.findPlaceForLine)(places, line);
                if (!place) {
                    toRemove.push(bp);
                    continue;
                }
                if (line !== place.idLine) {
                    toRemove.push(bp);
                    const pos = new vscode.Position(place.idLine, 0);
                    const loc = new vscode.Location(uri, pos);
                    toAdd.push(new vscode.SourceBreakpoint(loc, true));
                }
            }
            if (toRemove.length > 0) {
                vscode.debug.removeBreakpoints(toRemove);
                if (!notifiedBreakpointLimit) {
                    vscode.window.showInformationMessage('Breakpoints are restricted to EVOLVE PNML files (*.pnml.yaml, *.evolve.yaml). Other breakpoints were removed.');
                    notifiedBreakpointLimit = true;
                }
            }
            if (toAdd.length > 0) {
                vscode.debug.addBreakpoints(toAdd);
            }
        })().finally(() => {
            adjustingBreakpoints = false;
        });
    });
    // ===== InscriptEd: virtual inscription editor =====
    const allowedInscribeFile = (uri) => {
        if (!uri)
            return false;
        const p = (uri.path || '').toLowerCase();
        return p.endsWith('.pnml.yaml') || p.endsWith('.evolve.yaml');
    };
    const buildLineOffsets = (text) => {
        const offsets = [0];
        for (let i = 0; i < text.length; i++) {
            if (text[i] === '\n')
                offsets.push(i + 1);
        }
        return offsets;
    };
    const positionAt = (offsets, index) => {
        let low = 0;
        let high = offsets.length - 1;
        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            const start = offsets[mid];
            const next = mid + 1 < offsets.length ? offsets[mid + 1] : Number.MAX_SAFE_INTEGER;
            if (index < start)
                high = mid - 1;
            else if (index >= next)
                low = mid + 1;
            else
                return { line: mid, character: index - start };
        }
        return { line: 0, character: 0 };
    };
    const getInscriptionForLine = (text, line) => {
        const offsets = buildLineOffsets(text);
        const inscriptions = (0, inscripted_1.extractInscriptions)(text);
        for (const ins of inscriptions) {
            if (!ins.range)
                continue;
            const start = positionAt(offsets, ins.range.start).line;
            const end = positionAt(offsets, ins.range.end).line;
            if (line >= start && line <= end) {
                const codeLines = (ins.code || '').split(/\r?\n/);
                return { ins, startLine: start, codeLines };
            }
        }
        return undefined;
    };
    const buildGeneratedInscriptionLineMap = (text) => {
        const inscriptions = (0, inscripted_1.extractInscriptions)(text);
        const map = new Map();
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
    const isInInscriptionCode = (text, line) => {
        if (!text.includes('inscriptions:'))
            return false;
        const offsets = buildLineOffsets(text);
        const inscriptions = (0, inscripted_1.extractInscriptions)(text);
        return inscriptions.some((ins) => {
            if (!ins.range)
                return false;
            const start = positionAt(offsets, ins.range.start).line;
            const end = positionAt(offsets, ins.range.end).line;
            return line >= start && line <= end;
        });
    };
    const buildInscriptionUriObj = (sourceUri, index, lang) => vscode.Uri.parse((0, inscripted_1.buildInscriptionUri)(sourceUri, index, lang));
    const fsEmitter = new vscode.EventEmitter();
    const inscriptionFileSystem = vscode.workspace.registerFileSystemProvider('evolve-inscription', {
        onDidChangeFile: fsEmitter.event,
        watch(_uri, _options) {
            // No-op watcher; required by FileSystemProvider
            return { dispose() { } };
        },
        stat(_uri) {
            return { type: 1, ctime: Date.now(), mtime: Date.now(), size: 0 };
        },
        readDirectory() {
            return [];
        },
        createDirectory() {
            // no-op
        },
        readFile(uri) {
            const params = new URLSearchParams(uri.query);
            const source = params.get('source');
            const indexStr = params.get('index');
            if (!source || !indexStr)
                return Buffer.from('Missing source or index.', 'utf8');
            const index = parseInt(indexStr, 10);
            const sourceUri = vscode.Uri.parse(decodeURIComponent(source));
            const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === sourceUri.toString());
            if (!doc)
                return Buffer.from('Source document not found.', 'utf8');
            const inscriptions = (0, inscripted_1.extractInscriptions)(doc.getText());
            const ins = inscriptions.find((i) => i.index === index);
            const content = ins && typeof ins.code === 'string' ? ins.code : '';
            return Buffer.from(content, 'utf8');
        },
        writeFile(uri, content) {
            const params = new URLSearchParams(uri.query);
            const source = params.get('source');
            const indexStr = params.get('index');
            if (!source || !indexStr)
                return;
            const index = parseInt(indexStr, 10);
            const sourceUri = vscode.Uri.parse(decodeURIComponent(source));
            const text = Buffer.from(content).toString('utf8');
            (async () => {
                const sourceDoc = await vscode.workspace.openTextDocument(sourceUri);
                const updated = (0, inscripted_1.updateInscriptionText)(sourceDoc.getText(), index, text);
                const fullRange = new vscode.Range(0, 0, sourceDoc.lineCount, 0);
                const edit = new vscode.WorkspaceEdit();
                edit.replace(sourceUri, fullRange, updated);
                await vscode.workspace.applyEdit(edit);
            })();
        },
        delete() {
            // no-op
        },
        rename() {
            // no-op
        }
    }, { isCaseSensitive: true });
    const openInscription = async (sourceUri, index, lang) => {
        const uri = buildInscriptionUriObj(sourceUri.toString(), index, lang);
        const doc = await vscode.workspace.openTextDocument(uri);
        const { id } = (0, inscripted_1.getInscriptionLangExt)(lang);
        await vscode.languages.setTextDocumentLanguage(doc, id);
        await vscode.window.showTextDocument(doc, { preview: false });
    };
    const openInscriptionCmd = vscode.commands.registerCommand('evolve.openInscriptionEditor', async (sourceUri, index) => {
        const srcUri = vscode.Uri.parse(sourceUri);
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === srcUri.toString());
        if (!doc)
            return;
        const ins = (0, inscripted_1.extractInscriptions)(doc.getText()).find((i) => i.index === index);
        await openInscription(srcUri, index, ins?.language);
    });
    const openInscriptionAtCursorCmd = vscode.commands.registerCommand('evolve.openInscriptionAtCursor', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor)
            return;
        const doc = editor.document;
        if (!allowedInscribeFile(doc.uri))
            return;
        const text = doc.getText();
        const offsets = buildLineOffsets(text);
        const inscriptions = (0, inscripted_1.extractInscriptions)(text);
        const line = editor.selection.active.line;
        const match = inscriptions.find((ins) => {
            if (!ins.range)
                return false;
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
    const codeLensProvider = vscode.languages.registerCodeLensProvider([{ language: 'yaml', pattern: '**/*.{pnml.yaml,evolve.yaml}' }], {
        provideCodeLenses(document) {
            if (!allowedInscribeFile(document.uri))
                return [];
            const text = document.getText();
            const offsets = buildLineOffsets(text);
            const inscriptions = (0, inscripted_1.extractInscriptions)(text);
            const lenses = [];
            for (const ins of inscriptions) {
                if (!ins.range)
                    continue;
                const startPos = positionAt(offsets, ins.range.start);
                const endPos = positionAt(offsets, ins.range.start);
                const range = new vscode.Range(startPos.line, startPos.character, endPos.line, endPos.character);
                const title = `Edit inscription (${ins.language || 'unknown'})`;
                lenses.push(new vscode.CodeLens(range, {
                    title,
                    command: 'evolve.openInscriptionEditor',
                    arguments: [document.uri.toString(), ins.index]
                }));
            }
            return lenses;
        }
    });
    const runNetCmd = vscode.commands.registerCommand('evolve.runNet', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !allowedBreakpointFile(editor.document.uri)) {
            vscode.window.showInformationMessage('Open a *.pnml.yaml or *.evolve.yaml file to run.');
            return;
        }
        const runBridgeEnabled = vscode.workspace.getConfiguration('evolve').get('runBridge.enabled', true);
        let runBridgeEnv = {};
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
            moduleDir = (result && result.moduleDir) || '';
            if (moduleDir) {
                generatedModules.set(editor.document.uri.toString(), moduleDir);
            }
        }
        const pythonCmd = process.env.PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3');
        const terminal = vscode.window.createTerminal({ name: 'EVOLVE Run', env: runBridgeEnv });
        const mainPy = moduleDir ? path.join(moduleDir, 'main.py') : '';
        if (moduleDir && mainPy) {
            terminal.sendText(`${pythonCmd} ${mainPy} ${editor.document.uri.fsPath}`);
        }
        else {
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
            const dir = (result && result.moduleDir) || '';
            if (dir) {
                generatedModules.set(editor.document.uri.toString(), dir);
            }
        }
        await vscode.debug.startDebugging(undefined, {
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
        const pick = await vscode.window.showQuickPick([
            { label: '$(play) Run EVOLVE PNML', id: 'run' },
            { label: '$(debug-alt) Debug EVOLVE PNML', id: 'debug' }
        ], { placeHolder: 'Select action' });
        if (!pick)
            return;
        if (pick.id === 'run') {
            await vscode.commands.executeCommand('evolve.runNet');
        }
        else {
            await vscode.commands.executeCommand('evolve.debugNet');
        }
    });
    context.subscriptions.push(openGraphEditor, toggleBpCmd, bpListener, inscriptionFileSystem, openInscriptionCmd, openInscriptionAtCursorCmd, codeLensProvider, runNetCmd, debugNetCmd, showRunMenuCmd
    // no save listener needed; writeFile handles updates
    );
    const dapFactory = vscode.debug.registerDebugAdapterDescriptorFactory('evolve-pnml', {
        createDebugAdapterDescriptor() {
            const adapterPath = vscode.Uri.file(path.join(context.extensionPath, '..', 'enginepy', 'pnml_dap.py'));
            return new vscode.DebugAdapterExecutable(pythonCmd, ['-u', adapterPath.fsPath]);
        }
    });
    // Register tracker to handle custom requests from Python code
    const dapTrackerFactory = vscode.debug.registerDebugAdapterTrackerFactory('evolve-pnml', {
        createDebugAdapterTracker(session) {
            return {
                onDidSendMessage: async (message) => {
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
                            let result = null;
                            if (requestType === 'vscode/chat') {
                                result = await handleChatRequest(params);
                            }
                            else if (requestType === 'vscode/executeCommand') {
                                result = await handleExecuteCommand(params);
                            }
                            else if (requestType === 'vscode/getChatHistory') {
                                result = await handleGetChatHistory(params);
                            }
                            else if (requestType === 'vscode/showMessage') {
                                result = await handleShowMessage(params);
                            }
                            else {
                                throw new Error(`Unknown request type: ${requestType}`);
                            }
                            console.log(`[VSCode Bridge] Sending response for request ${requestId}`);
                            // Send response back to DAP
                            session.customRequest('customRequestResponse', {
                                requestId,
                                success: true,
                                result
                            }).catch((err) => {
                                console.error('Failed to send custom request response:', err);
                            });
                        }
                        catch (error) {
                            console.error(`[VSCode Bridge] Error handling request ${requestId}:`, error);
                            // Send error response back to DAP
                            session.customRequest('customRequestResponse', {
                                requestId,
                                success: false,
                                error: error.message || String(error)
                            }).catch((err) => {
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
function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes > 0) {
        return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
}
function formatPendingDetail(op) {
    const parts = [];
    if (op.resumeToken)
        parts.push(`token: ${op.resumeToken}`);
    if (op.runId)
        parts.push(`run: ${op.runId}`);
    if (op.timeoutMs) {
        const remaining = Math.max(0, op.timeoutMs - (Date.now() - op.createdAt));
        parts.push(`remaining: ${formatDuration(remaining)}`);
    }
    return parts.join(' · ');
}
function resolvePendingOperation(store, operationId) {
    if (operationId) {
        const op = store.findById(String(operationId));
        if (!op) {
            vscode.window.showWarningMessage('Pending operation not found.');
        }
        return op;
    }
    const pending = store.listPending();
    if (pending.length === 1)
        return pending[0];
    if (pending.length === 0) {
        vscode.window.showInformationMessage('No pending operations.');
        return undefined;
    }
    vscode.window.showInformationMessage('Multiple pending operations found. Use the pending list to select one.');
    return undefined;
}
async function promptForResult(op, prompt) {
    const input = await vscode.window.showInputBox({
        prompt,
        placeHolder: op.resumeToken ? `Token: ${op.resumeToken}` : undefined
    });
    if (input === undefined)
        return undefined;
    if (!input)
        return '';
    try {
        return JSON.parse(input);
    }
    catch {
        return input;
    }
}
async function submitOperation(op, payload) {
    const submitPayload = {
        operationId: op.operationId,
        resumeToken: op.resumeToken,
        result: payload.result,
        error: payload.error ?? null,
        source: payload.source
    };
    if (asyncSubmitHandler) {
        await asyncSubmitHandler(submitPayload);
    }
    else {
        await sendAsyncSubmit(submitPayload);
    }
    if (pendingOpsStore && op.status === 'pending') {
        if (submitPayload.error) {
            pendingOpsStore.markFailed(op.operationId, submitPayload.error || 'failed');
        }
        else {
            pendingOpsStore.markCompleted(op.operationId, submitPayload.result);
        }
    }
}
async function sendAsyncSubmit(payload) {
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
function handleAsyncOperationEvent(eventName, body) {
    if (!pendingOpsStore)
        return;
    if (eventName === 'asyncOperationStarted') {
        const createdAt = Number(body?.createdAt || Date.now());
        const timeoutMsRaw = body?.timeoutMs ||
            body?.metadata?.timeout ||
            body?.metadata?.timeoutMs ||
            body?.metadata?.timeout_ms;
        const timeoutMs = typeof timeoutMsRaw === 'number' ? timeoutMsRaw : Number(timeoutMsRaw || 0) || undefined;
        const op = {
            operationId: String(body?.operationId ?? body?.id ?? ''),
            transitionId: body?.transitionId,
            transitionName: body?.transitionName,
            transitionDescription: body?.transitionDescription,
            inscriptionId: body?.inscriptionId,
            netId: body?.netId,
            runId: body?.runId,
            operationType: body?.operationType,
            status: 'pending',
            resumeToken: body?.resumeToken,
            uiState: body?.uiState,
            metadata: body?.metadata,
            createdAt,
            timeoutMs
        };
        if (!op.operationId)
            return;
        pendingOpsStore.registerStarted(op);
        return;
    }
    if (eventName === 'asyncOperationUpdated') {
        const opId = String(body?.operationId ?? body?.id ?? '');
        if (!opId)
            return;
        const status = String(body?.status || 'pending');
        pendingOpsStore.updateStatus(opId, status, body?.result, body?.error);
    }
}
function renderJobsList(pending) {
    if (pending.length === 0) {
        return 'No pending operations.';
    }
    const lines = pending.map((op) => {
        const remaining = op.timeoutMs ? Math.max(0, op.timeoutMs - (Date.now() - op.createdAt)) : undefined;
        const remainingText = remaining !== undefined ? formatDuration(remaining) : 'n/a';
        return [
            `• ${op.transitionName || op.transitionId || op.operationId}`,
            `  token: ${op.resumeToken || 'n/a'}`,
            `  run: ${op.runId || 'n/a'} · net: ${op.netId || 'n/a'}`,
            `  timeout: ${remainingText}`
        ].join('\n');
    });
    return lines.join('\n');
}
async function handleSlashCommand(request, chatContext) {
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
async function ensureRunBridge() {
    if (runBridgeInfo && runBridgeSocketServer && runBridgeServer) {
        return buildRunBridgeEnv(runBridgeInfo);
    }
    const portSetting = vscode.workspace.getConfiguration('evolve').get('runBridge.port', 0) || 0;
    const token = crypto.randomBytes(16).toString('hex');
    const sessionId = crypto.randomBytes(8).toString('hex');
    const server = http.createServer();
    const wss = new ws_1.WebSocketServer({ server });
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
        const headerToken = (req.headers['x-evolve-run-bridge-token'] || req.headers['x-evolve-token'] || '').toString();
        const authHeader = (req.headers['authorization'] || '').toString();
        const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : '';
        const providedToken = headerToken || bearer;
        if (!providedToken || providedToken !== token) {
            res.statusCode = 401;
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }
        let body = '';
        req.on('data', (chunk) => {
            body += chunk.toString();
        });
        req.on('end', async () => {
            let payload;
            try {
                payload = body ? JSON.parse(body) : {};
            }
            catch {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
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
                res.statusCode = 404;
                res.end(JSON.stringify({ error: 'Unknown resumeToken' }));
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
    wss.on('connection', (socket, req) => {
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
            let payload;
            try {
                payload = JSON.parse(data.toString());
            }
            catch (err) {
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
                let result = null;
                if (requestType === 'vscode/chat') {
                    result = await handleChatRequest(params);
                }
                else if (requestType === 'vscode/executeCommand') {
                    result = await handleExecuteCommand(params);
                }
                else if (requestType === 'vscode/getChatHistory') {
                    result = await handleGetChatHistory(params);
                }
                else if (requestType === 'vscode/showMessage') {
                    result = await handleShowMessage(params);
                }
                else {
                    throw new Error(`Unknown request type: ${requestType}`);
                }
                socket.send(JSON.stringify({ id: requestId, success: true, result }));
            }
            catch (error) {
                socket.send(JSON.stringify({ id: requestId, success: false, error: error?.message || String(error) }));
            }
        });
        socket.on('close', () => {
            runBridgeClients.delete(socket);
        });
    });
    await new Promise((resolve, reject) => {
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
function buildRunBridgeEnv(info) {
    return {
        EVOLVE_RUN_BRIDGE_ADDR: info.addr,
        EVOLVE_RUN_BRIDGE_TOKEN: info.token,
        EVOLVE_RUN_BRIDGE_SESSION: info.sessionId
    };
}
/**
 * Select Copilot model using params.model, workspace setting, or fallback to first available model.
 */
async function selectCopilotModel(params) {
    const requested = params && params.model ? String(params.model) : '';
    // Workspace configured model (if any)
    const configured = vscode.workspace.getConfiguration('evolve').get('copilot.defaultModel', '') || '';
    const requestedModelId = requested || configured || '';
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (!Array.isArray(models) || models.length === 0)
        return null;
    if (requestedModelId) {
        // Exact match on id/name/displayName
        let found = models.find((m) => {
            const id = (m.id || m.name || m.displayName || '').toString();
            return id === requestedModelId;
        });
        if (!found) {
            // Fuzzy contains match (case-insensitive)
            const needle = requestedModelId.toLowerCase();
            found = models.find((m) => {
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
async function handleChatRequest(params) {
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
    const messages = [];
    for (const entry of history) {
        if (entry.role === 'user') {
            messages.push(vscode.LanguageModelChatMessage.User(entry.content));
        }
        else {
            messages.push(vscode.LanguageModelChatMessage.Assistant(entry.content));
        }
    }
    messages.push(vscode.LanguageModelChatMessage.User(message));
    const tokenSource = new vscode.CancellationTokenSource();
    const timeoutHandle = setTimeout(() => tokenSource.cancel(), timeout);
    try {
        const response = await model.sendRequest(messages, {}, tokenSource.token);
        let text = '';
        for await (const fragment of response.text) {
            text += fragment;
        }
        const normalized = text.trim().toLowerCase();
        const looksBlocked = normalized.startsWith("sorry, i can't assist") ||
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
    }
    catch (err) {
        const code = err?.code || err?.cause?.message || err?.message || '';
        const isOffTopic = String(code).includes('off_topic');
        if (isOffTopic) {
            if (openChatOnBlocked) {
                try {
                    await vscode.commands.executeCommand('workbench.action.chat.open', { query: message });
                }
                catch {
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
    }
    finally {
        clearTimeout(timeoutHandle);
        tokenSource.dispose();
    }
}
/**
 * Execute VS Code command from Python code
 */
async function handleExecuteCommand(params) {
    const command = params.command;
    const args = params.args || [];
    const timeout = params.timeout || 10000;
    if (!command) {
        throw new Error('Missing command parameter');
    }
    // Execute command with timeout
    const result = await Promise.race([
        vscode.commands.executeCommand(command, ...args),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Command timeout')), timeout))
    ]);
    return { result };
}
/**
 * Get chat history from Python code
 */
async function handleGetChatHistory(params) {
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
async function handleShowMessage(params) {
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
function __getPendingOpsStore() {
    return pendingOpsStore;
}
function __getPendingStatusText() {
    return pendingStatusBarItem?.text;
}
function __setAsyncSubmitHandler(handler) {
    asyncSubmitHandler = handler;
}
async function __handleSlashCommandForTests(command, prompt) {
    return handleSlashCommand({ command, prompt }, null);
}
function deactivate() {
    const stops = [];
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
//# sourceMappingURL=extension.js.map