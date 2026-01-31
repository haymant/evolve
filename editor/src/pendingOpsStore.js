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
exports.PendingOpsStore = void 0;
const vscode = __importStar(require("vscode"));
const STATE_KEY = "evolve.pendingOps";
class PendingOpsStore {
    constructor(context) {
        this.context = context;
        this.pendingById = new Map();
        this.pendingByToken = new Map();
        this.onDidChangeEmitter = new vscode.EventEmitter();
        this.onDidChangePendingOps = this.onDidChangeEmitter.event;
        this.restoreFromState();
    }
    registerStarted(op) {
        const normalized = this.normalize(op);
        this.pendingById.set(normalized.operationId, normalized);
        if (normalized.resumeToken) {
            this.pendingByToken.set(normalized.resumeToken, normalized.operationId);
        }
        this.persistState();
        this.onDidChangeEmitter.fire({ type: "started", op: normalized });
    }
    markCompleted(opId, result) {
        const op = this.pendingById.get(opId);
        if (!op)
            return;
        op.status = "completed";
        op.result = result;
        this.remove(op);
    }
    markFailed(opId, error) {
        const op = this.pendingById.get(opId);
        if (!op)
            return;
        op.status = "failed";
        op.error = error || "failed";
        this.remove(op);
    }
    markCancelled(opId, reason) {
        const op = this.pendingById.get(opId);
        if (!op)
            return;
        op.status = "cancelled";
        op.error = reason || "cancelled";
        this.remove(op);
    }
    updateStatus(opId, status, result, error) {
        const op = this.pendingById.get(opId);
        if (!op)
            return;
        op.status = status;
        if (result !== undefined)
            op.result = result;
        if (error !== undefined)
            op.error = error;
        if (status === "pending") {
            this.persistState();
            this.onDidChangeEmitter.fire({ type: "updated", op });
            return;
        }
        this.remove(op);
    }
    getPendingSummary() {
        if (this.pendingById.size === 0) {
            return { count: 0 };
        }
        let oldest = Number.MAX_SAFE_INTEGER;
        for (const op of this.pendingById.values()) {
            oldest = Math.min(oldest, op.createdAt || Date.now());
        }
        const oldestCreatedAt = oldest === Number.MAX_SAFE_INTEGER ? undefined : oldest;
        return {
            count: this.pendingById.size,
            oldestCreatedAt,
            oldestAgeMs: oldestCreatedAt ? Date.now() - oldestCreatedAt : undefined
        };
    }
    listPending() {
        return Array.from(this.pendingById.values()).sort((a, b) => a.createdAt - b.createdAt);
    }
    findById(opId) {
        return this.pendingById.get(opId);
    }
    findByToken(token) {
        const opId = this.pendingByToken.get(token);
        if (!opId)
            return undefined;
        return this.pendingById.get(opId);
    }
    remove(op) {
        this.pendingById.delete(op.operationId);
        if (op.resumeToken) {
            this.pendingByToken.delete(op.resumeToken);
        }
        this.persistState();
        this.onDidChangeEmitter.fire({ type: "removed", op });
    }
    normalize(op) {
        return {
            ...op,
            status: op.status || "pending",
            createdAt: op.createdAt || Date.now()
        };
    }
    restoreFromState() {
        const stored = this.context.workspaceState.get(STATE_KEY, []);
        for (const entry of stored) {
            const op = {
                operationId: String(entry.operationId),
                transitionName: entry.transitionName,
                transitionId: entry.transitionId,
                resumeToken: entry.resumeToken,
                runId: entry.runId,
                netId: entry.netId,
                operationType: entry.operationType,
                createdAt: entry.createdAt || Date.now(),
                timeoutMs: entry.timeoutMs,
                status: "pending"
            };
            this.pendingById.set(op.operationId, op);
            if (op.resumeToken) {
                this.pendingByToken.set(op.resumeToken, op.operationId);
            }
        }
    }
    persistState() {
        const entries = Array.from(this.pendingById.values()).map((op) => ({
            operationId: op.operationId,
            transitionName: op.transitionName,
            transitionId: op.transitionId,
            resumeToken: op.resumeToken,
            runId: op.runId,
            netId: op.netId,
            operationType: op.operationType,
            createdAt: op.createdAt,
            timeoutMs: op.timeoutMs
        }));
        void this.context.workspaceState.update(STATE_KEY, entries);
    }
}
exports.PendingOpsStore = PendingOpsStore;
//# sourceMappingURL=pendingOpsStore.js.map