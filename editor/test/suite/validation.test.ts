import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { suite, test } from 'mocha';

suite('PNML Validation Diagnostics', function () {
  this.timeout(20000);

  test('shows diagnostics when root key changes', async () => {
    const tmpDir = path.resolve(__dirname, '../../../../.tmp-tests');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    const filePath = path.join(tmpDir, 'validation.pnml.yaml');
    fs.writeFileSync(filePath, 'pnml:\n  net: []\n', 'utf8');

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(doc);

    const replaceRoot = new vscode.WorkspaceEdit();
    const firstLine = doc.lineAt(0);
    replaceRoot.replace(doc.uri, firstLine.range, 'pnml1:');
    await vscode.workspace.applyEdit(replaceRoot);

    const waitForDiagnostics = async (uri: vscode.Uri, ms: number) => {
      const start = Date.now();
      while (Date.now() - start < ms) {
        const diags = vscode.languages.getDiagnostics(uri);
        if (diags.length > 0) {
          return diags;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return [] as vscode.Diagnostic[];
    };

    const diagnostics = await waitForDiagnostics(doc.uri, 5000);
    assert.ok(diagnostics.length > 0, 'Expected diagnostics in PROBLEMS tab');
    assert.ok(
      diagnostics.some((d) => (d.source || '').toLowerCase().includes('yaml')),
      'Expected diagnostics to be reported by YAML language server'
    );

    fs.unlinkSync(filePath);
  });
});
