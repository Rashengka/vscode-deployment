// Extension tests run inside VS Code against the unpacked .vsix prepared by
// scripts/prepare-extension-test.mts (see `npm run test:extension`). The paths come from the
// same module the preparation script uses; they are specific to this checkout.
import { defineConfig } from '@vscode/test-cli';
import {
  EXTENSION_TEST_CONFIG,
  EXTENSION_TEST_EXTENSION,
  EXTENSION_TEST_USER_DATA,
  EXTENSION_TEST_WORKSPACE,
} from './scripts/lib/extensionTestPaths.mts';

export default defineConfig({
  files: 'out/test/extension/**/*.test.js',
  // The minimum version from package.json `engines.vscode`.
  version: '1.144.0',
  extensionDevelopmentPath: EXTENSION_TEST_EXTENSION,
  workspaceFolder: EXTENSION_TEST_WORKSPACE,
  // The extension does not run in untrusted workspaces; the test folder is created by the run.
  launchArgs: [
    '--disable-extensions',
    '--disable-workspace-trust',
    `--user-data-dir=${EXTENSION_TEST_USER_DATA}`,
  ],
  env: {
    VSCODE_DEPLOYMENT_EXTENSION_UNDER_TEST: EXTENSION_TEST_EXTENSION,
    VSCODE_DEPLOYMENT_CONFIG_DIR: EXTENSION_TEST_CONFIG,
  },
  mocha: {
    ui: 'bdd',
    timeout: 120_000,
    forbidOnly: true,
    // Zero discovered tests is a failure, not a green run.
    failZero: true,
  },
});
