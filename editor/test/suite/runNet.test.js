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
const assert = __importStar(require("assert"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const vscode = __importStar(require("vscode"));
const child_process_1 = require("child_process");
suite('Run PNML Tests', () => {
    suiteSetup(() => {
        // Ensure runner binary is built
        const root = path.resolve(__dirname, '../../../engine');
        (0, child_process_1.execSync)('cargo build -p pnets_runner', { cwd: root, stdio: 'inherit' });
    });
    test('runs sample net and writes trace', async () => {
        const sample = path.resolve(__dirname, '../../../../examples/HouseBuild.evolve.yaml');
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(sample));
        await vscode.window.showTextDocument(doc);
        // delete any existing log files
        const tmp = require('os').tmpdir();
        const logGlob = path.join(tmp, 'evolve-debug-*.log');
        // Run the debug command which should create a log file
        await vscode.commands.executeCommand('evolve.debugNet');
        // Wait for the log file to be created
        const start = Date.now();
        let found;
        while (Date.now() - start < 10000) {
            const files = fs.readdirSync(tmp).filter((f) => f.startsWith('evolve-debug-'));
            if (files.length > 0) {
                found = path.join(tmp, files[0]);
                break;
            }
            await new Promise((r) => setTimeout(r, 200));
        }
        assert.ok(found, 'Expected a log file to be created by runner');
        const text = fs.readFileSync(found, 'utf8');
        assert.ok(text.includes('Trace:') || text.includes('Step'), 'Expected trace or step output in log');
    });
});
//# sourceMappingURL=runNet.test.js.map