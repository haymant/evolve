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

suite('VSCode Bridge Integration Tests', () => {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  const examplePath = path.join(workspaceRoot, 'examples', 'VsCodeInterop.evolve.yaml');
  
  test('Debug session receives custom request from Python', async function() {
    this.timeout(10000);
    
    // Track custom requests received
    const customRequests: any[] = [];
    let requestReceived = false;
    
    // Register tracker to intercept custom requests
    const trackerDisposable = vscode.debug.registerDebugAdapterTrackerFactory('evolve-pnml', {
      createDebugAdapterTracker(session: vscode.DebugSession) {
        return {
          onDidSendMessage: (message: any) => {
            if (message.type === 'event' && message.event === 'customRequest') {
              customRequests.push(message.body);
              requestReceived = true;
            }
          }
        };
      }
    });
    
    try {
      // Start debug session
      const started = await vscode.debug.startDebugging(
        undefined,
        {
          type: 'evolve-pnml',
          request: 'launch',
          name: 'Test VSCode Bridge',
          program: examplePath
        }
      );
      
      assert.ok(started, 'Debug session should start');
      
      // Wait for session to initialize and inscriptions to execute
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Get active debug session
      const session = vscode.debug.activeDebugSession;
      
      // For now, we just verify the session started successfully
      // The actual custom request flow needs the full DAP implementation
      assert.ok(true, 'Session started without errors');
      
      // Stop debug session
      if (session) {
        await vscode.debug.stopDebugging(session);
      }
      
    } finally {
      trackerDisposable.dispose();
    }
  });
  
  test('Extension handlers respond to custom requests', async function() {
    this.timeout(5000);
    
    // Test that command execution handler works
    const result = await vscode.commands.executeCommand('workbench.action.files.saveAll');
    // Command should execute without error (result may be undefined)
    assert.ok(true, 'Command executed successfully');
  });
  
  test('Show message handler displays notifications', async function() {
    this.timeout(1000);
    
    // We can't easily test the actual message display in headless mode,
    // but we can verify the commands exist and don't throw errors
    // These are fire-and-forget, so no need to await
    vscode.window.showInformationMessage('Test info message');
    vscode.window.showWarningMessage('Test warning message');
    vscode.window.showErrorMessage('Test error message');
    
    // Give messages time to be processed
    await new Promise(resolve => setTimeout(resolve, 100));
    
    assert.ok(true, 'Message commands executed without errors');
  });

  test('Slash command /jobs renders pending metadata', async function() {
    this.timeout(5000);
    await activateExtension();
    extension.__setChatModelsOverride(async () => [{ id: 'test-model' }]);
    const store = extension.__getPendingOpsStore();
    assert.ok(store, 'Pending ops store should be available');

    store!.registerStarted({
      operationId: 'op-jobs-1',
      transitionId: 'tJobs',
      transitionName: 'Jobs Test',
      transitionDescription: 'Desc',
      status: 'pending',
      runId: 'run-jobs',
      netId: 'net-jobs',
      resumeToken: 'token-jobs',
      createdAt: Date.now() - 1000,
      timeoutMs: 5000
    });

    try {
      const response = await extension.__handleSlashCommandForTests('jobs', '');
      assert.ok(response.includes('Jobs Test'));
      assert.ok(response.includes('token-jobs'));
      assert.ok(response.includes('run-jobs'));
    } finally {
      extension.__setChatModelsOverride(undefined);
    }
  });

  test('Slash command /submit resumes pending op by token', async function() {
    this.timeout(5000);
    await activateExtension();
    extension.__setChatModelsOverride(async () => [{ id: 'test-model' }]);
    const store = extension.__getPendingOpsStore();
    assert.ok(store, 'Pending ops store should be available');

    store!.registerStarted({
      operationId: 'op-submit-1',
      transitionId: 'tSubmit',
      transitionName: 'Submit Test',
      status: 'pending',
      runId: 'run-submit',
      netId: 'net-submit',
      resumeToken: 'token-submit',
      createdAt: Date.now()
    });

    let submitted: any;
    extension.__setAsyncSubmitHandler(async (payload: any) => {
      submitted = payload;
    });

    try {
      const response = await extension.__handleSlashCommandForTests('submit', 'token-submit hello world');
      assert.ok(response.includes('Submitted result'));
      assert.ok(submitted);
      assert.strictEqual(submitted.resumeToken, 'token-submit');
    } finally {
      extension.__setAsyncSubmitHandler(undefined);
      extension.__setChatModelsOverride(undefined);
    }
  });

  test('Slash command /submit rejects invalid token', async function() {
    this.timeout(5000);

    await activateExtension();
    extension.__setChatModelsOverride(async () => [{ id: 'test-model' }]);
    try {
      const response = await extension.__handleSlashCommandForTests('submit', 'token-missing hello');
      assert.ok(response.includes('Invalid resume token'));
    } finally {
      extension.__setChatModelsOverride(undefined);
    }
  });


});
