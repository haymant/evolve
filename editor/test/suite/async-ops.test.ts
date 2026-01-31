import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import { suite, test } from 'mocha';
const extension = require('../../../dist/extension');

async function activateExtension(): Promise<void> {
  const ext = vscode.extensions.all.find((item) => item.packageJSON?.name === 'evolve-editor');
  if (!ext) {
    throw new Error('Extension evolve-editor not found');
  }
  await ext.activate();
}

suite('Async Operations UI Tests', () => {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

  async function waitForPendingCount(target: number, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const store = extension.__getPendingOpsStore();
      if (store && store.listPending().length >= target) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${target} pending operation(s).`);
  }

  async function waitForDebugSession(timeoutMs: number): Promise<vscode.DebugSession> {
    const existing = vscode.debug.activeDebugSession;
    if (existing) return existing;
    return new Promise<vscode.DebugSession>((resolve, reject) => {
      const timeout = setTimeout(() => {
        sub.dispose();
        reject(new Error('Timed out waiting for debug session'));
      }, timeoutMs);
      const sub = vscode.debug.onDidStartDebugSession((session) => {
        clearTimeout(timeout);
        sub.dispose();
        resolve(session);
      });
    });
  }

  function cleanupPendingOps(): void {
    const store = extension.__getPendingOpsStore();
    if (!store) return;
    for (const op of store.listPending()) {
      store.markCancelled(op.operationId, 'test-cleanup');
    }
  }

  test('Status bar item updates when pending count changes', async () => {
    await activateExtension();
    const store = extension.__getPendingOpsStore();
    assert.ok(store, 'Pending ops store should be available');

    store!.registerStarted({
      operationId: 'op-status-1',
      transitionId: 't1',
      transitionName: 'Status Test',
      status: 'pending',
      runId: 'run-1',
      netId: 'net-1',
      createdAt: Date.now()
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const text = extension.__getPendingStatusText();
    assert.ok(text && text.includes('(1)'), 'Status bar should show one pending op');

    store!.markCompleted('op-status-1', { ok: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const textAfter = extension.__getPendingStatusText();
    assert.ok(textAfter && textAfter.includes('(0)'), 'Status bar should show zero pending ops');
  });

  test('Notification actions include pending list and resume form', async () => {
    await activateExtension();
    const store = extension.__getPendingOpsStore();
    assert.ok(store, 'Pending ops store should be available');

    const originalInfo = vscode.window.showInformationMessage;
    const originalExecute = vscode.commands.executeCommand;
    let capturedActions: string[] = [];
    let executedCommand: string | undefined;

    (vscode.window as any).showInformationMessage = (message: string, ...items: string[]) => {
      capturedActions = items;
      return Promise.resolve('Open pending list');
    };
    (vscode.commands as any).executeCommand = (command: string, ..._args: any[]) => {
      executedCommand = command;
      return Promise.resolve(undefined);
    };

    try {
      store!.registerStarted({
        operationId: 'op-notify-1',
        transitionId: 't2',
        transitionName: 'Notify Test',
        status: 'pending',
        runId: 'run-2',
        netId: 'net-2',
        createdAt: Date.now(),
        operationType: 'form'
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(capturedActions.includes('Open pending list'));
      assert.ok(capturedActions.includes('Resume form'));
      assert.strictEqual(executedCommand, 'evolve.listPendingOperations');
    } finally {
      (vscode.window as any).showInformationMessage = originalInfo;
      (vscode.commands as any).executeCommand = originalExecute;
    }
  });

  test('GenericAsync example emits pending async operation', async function () {
    this.timeout(15000);
    await activateExtension();
    cleanupPendingOps();

    const examplePath = workspaceRoot
      ? path.join(workspaceRoot, 'examples', 'GenericAsync.evolve.yaml')
      : path.resolve(__dirname, '../../../../examples/GenericAsync.evolve.yaml');
    const started = await vscode.debug.startDebugging(undefined, {
      type: 'evolve-pnml',
      request: 'launch',
      name: 'Test Generic Async',
      program: examplePath
    });
    assert.ok(started, 'Debug session should start');

    try {
      const session = await waitForDebugSession(5000);
      await session.customRequest('next', { threadId: 1 });
      await waitForPendingCount(1, 8000);
      const store = extension.__getPendingOpsStore();
      const pending = store?.listPending() || [];
      assert.ok(pending.length >= 1, 'Expected at least one pending op');
      assert.strictEqual(pending[0].operationType, 'form');
    } finally {
      if (vscode.debug.activeDebugSession) {
        await vscode.debug.stopDebugging(vscode.debug.activeDebugSession);
      }
      cleanupPendingOps();
    }
  });

  test('Resume form submits result payload', async () => {
    await activateExtension();
    const store = extension.__getPendingOpsStore();
    assert.ok(store, 'Pending ops store should be available');

    const originalInput = vscode.window.showInputBox;
    let submitted: any;

    (vscode.window as any).showInputBox = () => Promise.resolve('{"approved":true}');
    extension.__setAsyncSubmitHandler(async (payload: any) => {
      submitted = payload;
    });

    try {
      store!.registerStarted({
        operationId: 'op-form-1',
        transitionId: 't3',
        transitionName: 'Form Test',
        status: 'pending',
        runId: 'run-3',
        netId: 'net-3',
        createdAt: Date.now(),
        operationType: 'form'
      });

      await vscode.commands.executeCommand('evolve.resumeForm', 'op-form-1');
      assert.ok(submitted);
      assert.strictEqual(submitted.operationId, 'op-form-1');
      assert.deepStrictEqual(submitted.result, { approved: true });
    } finally {
      (vscode.window as any).showInputBox = originalInput;
      extension.__setAsyncSubmitHandler(undefined);
    }
  });

  test('Cancel operation submits error and removes pending', async () => {
    await activateExtension();
    const store = extension.__getPendingOpsStore();
    assert.ok(store, 'Pending ops store should be available');

    let submitted: any;
    extension.__setAsyncSubmitHandler(async (payload: any) => {
      submitted = payload;
    });

    try {
      store!.registerStarted({
        operationId: 'op-cancel-1',
        transitionId: 't4',
        transitionName: 'Cancel Test',
        status: 'pending',
        runId: 'run-4',
        netId: 'net-4',
        createdAt: Date.now()
      });

      await vscode.commands.executeCommand('evolve.cancelOperation', 'op-cancel-1');
      assert.ok(submitted);
      assert.strictEqual(submitted.operationId, 'op-cancel-1');
      assert.strictEqual(submitted.error, 'cancelled');
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.strictEqual(store!.findById('op-cancel-1'), undefined);
    } finally {
      extension.__setAsyncSubmitHandler(undefined);
    }
  });
});
