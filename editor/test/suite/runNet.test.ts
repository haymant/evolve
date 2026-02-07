import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { suite, test } from 'mocha';

suite('DAP PNML Tests', function () {
  this.timeout(30000);

  test('run mode terminates', async () => {
    const sample = path.resolve(__dirname, '../../../../examples/HouseBuild.evolve.yaml');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(sample));
    await vscode.window.showTextDocument(doc);

    let outputText = '';
    const outputQueue: Array<(text: string) => void> = [];
    const outputPromise = () => new Promise<string>((resolve) => { if (outputText.includes('Moving from Room1 to Room2')) return resolve(outputText); outputQueue.push(resolve); });
    const tracker = vscode.debug.registerDebugAdapterTrackerFactory('evolve-pnml', {
      createDebugAdapterTracker(session) {
        return {
          onDidSendMessage: (message) => {
            if (message?.type === 'event' && message.event === 'output') {
              const chunk = String(message.body?.output || '');
              outputText += chunk;
              const resolve = outputQueue.shift();
              if (resolve) {
                resolve(outputText);
              }
            }
          }
        };
      }
    });

    const term = new Promise<vscode.DebugSession>((resolve) => {
      const sub = vscode.debug.onDidTerminateDebugSession((s) => {
        sub.dispose();
        resolve(s);
      });
    });

    const started = await vscode.debug.startDebugging(undefined, {
      type: 'evolve-pnml',
      name: 'Run EVOLVE PNML',
      request: 'launch',
      program: sample,
      noDebug: true
    });
    assert.ok(started, 'Run session did not start');

    const session = await Promise.race([
      term,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for terminate')), 5000))
    ]);
    assert.ok(session, 'Expected terminate event');
    await Promise.race([
      outputPromise().then((text) => {
        assert.ok(text.includes('Moving from Room1 to Room2'), 'Expected inscription output in run mode');
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for inscription output')), 5000))
    ]);
    tracker.dispose();
  });

  test('breakpoint, step, continue', async () => {
    const sample = path.resolve(__dirname, '../../../../examples/HouseBuild.evolve.yaml');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(sample));
    await vscode.window.showTextDocument(doc);

    const lines = fs.readFileSync(sample, 'utf8').split(/\r?\n/);
    const p2Line = lines.findIndex((l) => /\bid:\s*p2\b/.test(l));
    assert.ok(p2Line >= 0, 'Expected to find id: p2 line');

    const withTimeout = async <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
      let timer: NodeJS.Timeout;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timeout waiting for ${label}`)), ms);
      });
      const result = await Promise.race([p, timeout]);
      clearTimeout(timer!);
      return result as T;
    };

    const stoppedQueue: Array<(e: any) => void> = [];
    const stoppedPromise = () => new Promise<any>((resolve) => stoppedQueue.push(resolve));
    let outputText = '';
    const outputQueue: Array<(text: string) => void> = [];
    const outputPromise = () => new Promise<string>((resolve) => { if (outputText.includes('Moving from Room1 to Room2')) return resolve(outputText); outputQueue.push(resolve); });

    const tracker = vscode.debug.registerDebugAdapterTrackerFactory('evolve-pnml', {
      createDebugAdapterTracker(session) {
        return {
          onDidSendMessage: (message) => {
            if (message?.type === 'event' && message.event === 'stopped') {
              const resolve = stoppedQueue.shift();
              if (resolve) {
                resolve({ session, body: message.body });
              }
            }
            if (message?.type === 'event' && message.event === 'output') {
              const chunk = String(message.body?.output || '');
              outputText += chunk;
              const resolve = outputQueue.shift();
              if (resolve) {
                resolve(outputText);
              }
            }
          }
        };
      }
    });

    const sessionStarted = new Promise<vscode.DebugSession>((resolve) => {
      const sub = vscode.debug.onDidStartDebugSession((s) => {
        sub.dispose();
        resolve(s);
      });
    });

    const bp = new vscode.SourceBreakpoint(new vscode.Location(doc.uri, new vscode.Position(p2Line, 0)), true);
    vscode.debug.addBreakpoints([bp]);

    const cfg = { type: 'evolve-pnml', name: 'Test PNML', request: 'launch', program: sample };
    const started = await vscode.debug.startDebugging(undefined, cfg);
    assert.ok(started, 'Debug session did not start');

    const session = await withTimeout(sessionStarted, 5000, 'debug session start');

    try {
      const stopped = await withTimeout(stoppedPromise(), 10000, 'breakpoint stop');
      assert.ok(stopped.body?.reason === 'breakpoint' || stopped.body?.reason === 'step', 'Expected stop reason');
      await withTimeout(
        outputPromise().then((text) => {
          assert.ok(text.includes('Moving from Room1 to Room2'), 'Expected inscription output in debug mode');
        }),
        10000,
        'inscription output'
      );

      const stack = await session.customRequest('stackTrace', { threadId: 1 });
      assert.ok(stack.stackFrames?.length >= 1, 'Expected stack frames from history');
      const p1Line = lines.findIndex((l) => /\bid:\s*p1\b/.test(l));
      const placeLines = [p1Line, p2Line].filter((l) => l >= 0).map((l) => l + 1);
      const hasPlaceLine = stack.stackFrames.some((f: any) => placeLines.includes(f.line));
      assert.ok(hasPlaceLine, 'Expected stack frame at a place id line');

      const scopes = await session.customRequest('scopes', { frameId: 1 });
      const markingScope = scopes.scopes?.find((s: any) => s.name === 'Marking');
      if (markingScope) {
        const vars = await session.customRequest('variables', { variablesReference: markingScope.variablesReference });
        const p2 = vars.variables?.find((v: any) => v.name === 'p2');
        if (p2Line >= 0) {
          assert.ok(p2 && String(p2.value).includes('Blue'), 'Expected p2 marking to include Blue');
        }
      }

      vscode.debug.removeBreakpoints([bp]);

      const stepStop = stoppedPromise();

      const stepTerm = new Promise<void>((resolve) => {
        const sub = vscode.debug.onDidTerminateDebugSession((s) => {
          if (s === session) {
            sub.dispose();
            resolve();
          }
        });
      });

      await session.customRequest('next', { threadId: 1 });
      const stepResult = await withTimeout(
        Promise.race([
          stepStop.then(() => 'stopped' as const),
          stepTerm.then(() => 'terminated' as const)
        ]),
        10000,
        'step stop'
      );

      const term = new Promise<void>((resolve) => {
        const sub = vscode.debug.onDidTerminateDebugSession((s) => {
          if (s === session) {
            sub.dispose();
            resolve();
          }
        });
      });

      if (stepResult === 'stopped') {
        await session.customRequest('continue', { threadId: 1 });
        await withTimeout(term, 10000, 'terminate');
      }
    } finally {
      vscode.debug.removeBreakpoints([bp]);
      tracker.dispose();
    }

  });

  test('p2 breakpoint continues to terminate', async () => {
    const sample = path.resolve(__dirname, '../../../../examples/HouseBuild.evolve.yaml');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(sample));
    await vscode.window.showTextDocument(doc);

    const lines = fs.readFileSync(sample, 'utf8').split(/\r?\n/);
    const p2Line = lines.findIndex((l) => /\bid:\s*p2\b/.test(l));
    assert.ok(p2Line >= 0, 'Expected to find id: p2 line');

    const stoppedQueue: Array<(e: any) => void> = [];
    const stoppedPromise = () => new Promise<any>((resolve) => stoppedQueue.push(resolve));

    const tracker = vscode.debug.registerDebugAdapterTrackerFactory('evolve-pnml', {
      createDebugAdapterTracker(session) {
        return {
          onDidSendMessage: (message) => {
            if (message?.type === 'event' && message.event === 'stopped') {
              const resolve = stoppedQueue.shift();
              if (resolve) {
                resolve({ session, body: message.body });
              }
            }
          }
        };
      }
    });

    const sessionStarted = new Promise<vscode.DebugSession>((resolve) => {
      const sub = vscode.debug.onDidStartDebugSession((s) => {
        sub.dispose();
        resolve(s);
      });
    });

    const bp = new vscode.SourceBreakpoint(new vscode.Location(doc.uri, new vscode.Position(p2Line, 0)), true);
    vscode.debug.addBreakpoints([bp]);

    const started = await vscode.debug.startDebugging(undefined, {
      type: 'evolve-pnml',
      name: 'Test PNML p2 break',
      request: 'launch',
      program: sample
    });
    assert.ok(started, 'Debug session did not start');
    const session = await sessionStarted;

    const stopped = await Promise.race([
      stoppedPromise(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for breakpoint stop')), 10000))
    ]);
    assert.ok(stopped, 'Expected breakpoint stop');

    const term = new Promise<void>((resolve) => {
      const sub = vscode.debug.onDidTerminateDebugSession((s) => {
        if (s === session) {
          sub.dispose();
          resolve();
        }
      });
    });

    await session.customRequest('continue', { threadId: 1 });
    await Promise.race([
      term,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for terminate')), 10000))
    ]);

    vscode.debug.removeBreakpoints([bp]);
    tracker.dispose();
  });

  test('code block breakpoint maps to inscriptions', async () => {
    const sample = path.resolve(__dirname, '../../../../examples/HouseBuild.evolve.yaml');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(sample));
    await vscode.window.showTextDocument(doc);

    const lines = fs.readFileSync(sample, 'utf8').split(/\r?\n/);
    const codeLine = lines.findIndex((l) => l.includes('Moving from Room1 to Room2'));
    assert.ok(codeLine >= 0, 'Expected to find code block line');

    const stoppedQueue: Array<(e: any) => void> = [];
    const stoppedPromise = () => new Promise<any>((resolve) => stoppedQueue.push(resolve));

    const tracker = vscode.debug.registerDebugAdapterTrackerFactory('evolve-pnml', {
      createDebugAdapterTracker(session) {
        return {
          onDidSendMessage: (message) => {
            if (message?.type === 'event' && message.event === 'stopped') {
              const resolve = stoppedQueue.shift();
              if (resolve) {
                resolve({ session, body: message.body });
              }
            }
          }
        };
      }
    });

    const sessionStarted = new Promise<vscode.DebugSession>((resolve) => {
      const sub = vscode.debug.onDidStartDebugSession((s) => {
        sub.dispose();
        resolve(s);
      });
    });

    const bp = new vscode.SourceBreakpoint(new vscode.Location(doc.uri, new vscode.Position(codeLine, 0)), true);
    vscode.debug.addBreakpoints([bp]);

    const started = await vscode.debug.startDebugging(undefined, {
      type: 'evolve-pnml',
      name: 'Test PNML code breakpoint',
      request: 'launch',
      program: sample
    });
    assert.ok(started, 'Debug session did not start');
    const session = await sessionStarted;

    const stopped = await Promise.race([
      stoppedPromise(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for code breakpoint stop')), 10000))
    ]);
    assert.ok(stopped, 'Expected code breakpoint stop');

    const stack = await session.customRequest('stackTrace', { threadId: 1 });
    const hasInscription = stack.stackFrames?.some((f: any) => String(f.source?.path || '').includes('inscriptions.py'));
    assert.ok(hasInscription, 'Expected stack frame in inscriptions.py');

    vscode.debug.removeBreakpoints([bp]);
    tracker.dispose();
  });

});
