import * as vscode from "vscode";

export type PendingOpStatus = "pending" | "completed" | "cancelled" | "failed";

export type PendingOp = {
  operationId: string;
  transitionId?: string;
  transitionName?: string;
  transitionDescription?: string;
  inscriptionId?: string;
  netId?: string;
  runId?: string;
  operationType?: string;
  status: PendingOpStatus;
  resumeToken?: string;
  uiState?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  createdAt: number;
  timeoutMs?: number;
  result?: unknown;
  error?: string | null;
};

export type PendingOpsSummary = {
  count: number;
  oldestCreatedAt?: number;
  oldestAgeMs?: number;
};

export type PendingOpsChangeEvent = {
  type: "started" | "updated" | "removed";
  op: PendingOp;
};

const STATE_KEY = "evolve.pendingOps";

type StoredPendingOp = {
  operationId: string;
  transitionName?: string;
  transitionId?: string;
  resumeToken?: string;
  runId?: string;
  netId?: string;
  operationType?: string;
  createdAt: number;
  timeoutMs?: number;
};

export class PendingOpsStore {
  private readonly pendingById = new Map<string, PendingOp>();
  private readonly pendingByToken = new Map<string, string>();
  private readonly onDidChangeEmitter = new vscode.EventEmitter<PendingOpsChangeEvent>();
  readonly onDidChangePendingOps = this.onDidChangeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.restoreFromState();
  }

  registerStarted(op: PendingOp): void {
    const normalized = this.normalize(op);
    this.pendingById.set(normalized.operationId, normalized);
    if (normalized.resumeToken) {
      this.pendingByToken.set(normalized.resumeToken, normalized.operationId);
    }
    this.persistState();
    this.onDidChangeEmitter.fire({ type: "started", op: normalized });
  }

  markCompleted(opId: string, result?: unknown): void {
    const op = this.pendingById.get(opId);
    if (!op) return;
    op.status = "completed";
    op.result = result;
    this.remove(op);
  }

  markFailed(opId: string, error?: string): void {
    const op = this.pendingById.get(opId);
    if (!op) return;
    op.status = "failed";
    op.error = error || "failed";
    this.remove(op);
  }

  markCancelled(opId: string, reason?: string): void {
    const op = this.pendingById.get(opId);
    if (!op) return;
    op.status = "cancelled";
    op.error = reason || "cancelled";
    this.remove(op);
  }

  updateStatus(opId: string, status: PendingOpStatus, result?: unknown, error?: string | null): void {
    const op = this.pendingById.get(opId);
    if (!op) return;
    op.status = status;
    if (result !== undefined) op.result = result;
    if (error !== undefined) op.error = error;
    if (status === "pending") {
      this.persistState();
      this.onDidChangeEmitter.fire({ type: "updated", op });
      return;
    }
    this.remove(op);
  }

  getPendingSummary(): PendingOpsSummary {
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

  listPending(): PendingOp[] {
    return Array.from(this.pendingById.values()).sort((a, b) => a.createdAt - b.createdAt);
  }

  findById(opId: string): PendingOp | undefined {
    return this.pendingById.get(opId);
  }

  findByToken(token: string): PendingOp | undefined {
    const opId = this.pendingByToken.get(token);
    if (!opId) return undefined;
    return this.pendingById.get(opId);
  }

  private remove(op: PendingOp): void {
    this.pendingById.delete(op.operationId);
    if (op.resumeToken) {
      this.pendingByToken.delete(op.resumeToken);
    }
    this.persistState();
    this.onDidChangeEmitter.fire({ type: "removed", op });
  }

  private normalize(op: PendingOp): PendingOp {
    return {
      ...op,
      status: op.status || "pending",
      createdAt: op.createdAt || Date.now()
    };
  }

  private restoreFromState(): void {
    const stored = this.context.workspaceState.get<StoredPendingOp[]>(STATE_KEY, []);
    for (const entry of stored) {
      const op: PendingOp = {
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

  private persistState(): void {
    const entries: StoredPendingOp[] = Array.from(this.pendingById.values()).map((op) => ({
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
