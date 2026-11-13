import { strict as assert } from 'node:assert';
import { realpathSync } from 'node:fs';
import * as vscode from 'vscode';

export const EXTENSION_ID = 'rashengka.vscode-deployment';

/**
 * Returns the extension and asserts that VS Code loaded it from the unpacked `.vsix`
 * (and not from the development tree).
 */
export function extensionUnderTest(): vscode.Extension<unknown> {
  const expectedPath = process.env['VSCODE_DEPLOYMENT_EXTENSION_UNDER_TEST'];
  assert.ok(expectedPath, 'VSCODE_DEPLOYMENT_EXTENSION_UNDER_TEST is not set');

  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} is not installed in the test instance`);
  assert.equal(realpathSync(extension.extensionPath), realpathSync(expectedPath));
  return extension;
}
