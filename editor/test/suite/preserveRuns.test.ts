import * as assert from 'assert';
import * as vscode from 'vscode';
import { suite, test } from 'mocha';

suite('Preserve Runs Setting', function () {
  this.timeout(5000);

  test('toggle preserve run dirs command updates configuration', async () => {
    const cfg = vscode.workspace.getConfiguration('evolve');
    // ensure known starting state
    await cfg.update('preserveRunDirs', false, vscode.ConfigurationTarget.Global);
    // toggle on
    await vscode.commands.executeCommand('evolve.togglePreserveRunDirs');
    let val = vscode.workspace.getConfiguration('evolve').get<boolean>('preserveRunDirs');
    assert.strictEqual(val, true);
    // toggle off
    await vscode.commands.executeCommand('evolve.togglePreserveRunDirs');
    val = vscode.workspace.getConfiguration('evolve').get<boolean>('preserveRunDirs');
    assert.strictEqual(val, false);
  });
});