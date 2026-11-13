// Extension tests run inside VS Code against the unpacked .vsix prepared by
// scripts/prepare-extension-test.mts (see `npm run test:extension`).
import { defineConfig } from '@vscode/test-cli';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Keep in sync with scripts/lib/extensionTestPaths.mts.
const extensionUnderTest = join(
  tmpdir(),
  'vscode-deployment-extension-test',
  'unpacked',
  'extension',
);

// Keep in sync with EXTENSION_TEST_USER_DATA in scripts/lib/extensionTestPaths.mts.
const userDataDir = join(tmpdir(), 'vscode-deployment-ud');

// Keep in sync with EXTENSION_TEST_WORKSPACE and EXTENSION_TEST_CONFIG.
const workspaceFolder = join(tmpdir(), 'vscode-deployment-ws');
const configDir = join(tmpdir(), 'vscode-deployment-cfg', 'vscode-deployment');

export default defineConfig({
  files: 'out/test/extension/**/*.test.js',
  // The minimum version from package.json `engines.vscode`.
  version: '1.144.0',
  extensionDevelopmentPath: extensionUnderTest,
  workspaceFolder,
  // The extension does not run in untrusted workspaces; the test folder is created by the run.
  launchArgs: [
    '--disable-extensions',
    '--disable-workspace-trust',
    `--user-data-dir=${userDataDir}`,
  ],
  env: {
    VSCODE_DEPLOYMENT_EXTENSION_UNDER_TEST: extensionUnderTest,
    VSCODE_DEPLOYMENT_CONFIG_DIR: configDir,
  },
  mocha: {
    ui: 'bdd',
    timeout: 120_000,
    forbidOnly: true,
    // Zero discovered tests is a failure, not a green run.
    failZero: true,
  },
});
