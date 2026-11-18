// Extension tests run inside VS Code against the unpacked .vsix prepared by
// scripts/prepare-extension-test.mts (see `npm run test:extension`). The paths come from the
// same module the preparation script uses; they are specific to this checkout.
//
// Both instances get only an allowlisted environment (scripts/lib/extensionTestEnv.mts) and
// never touch the operating system's credential store: VS Code keeps secrets in memory and
// Chromium uses a mock keychain and a plain-text password store.
import { defineConfig } from '@vscode/test-cli';
import { extensionTestEnvironment } from './scripts/lib/extensionTestEnv.mts';
import {
  CANARY_INSTANCE,
  EXTENSION_TEST_EXTENSION,
  MAIN_INSTANCE,
} from './scripts/lib/extensionTestPaths.mts';

/**
 * Set here and removed again by the allowlist; a test checks that it does not reach the
 * extension host, which shows that variables of this process are really dropped.
 */
export const ENVIRONMENT_SENTINEL = 'VSCODE_DEPLOYMENT_ENVIRONMENT_SENTINEL';
process.env[ENVIRONMENT_SENTINEL] = 'set';

const ISOLATION_ARGS = [
  '--disable-extensions',
  '--disable-workspace-trust',
  // Never read the environment of the user's login shell.
  '--force-disable-user-env',
  // Never ask for (or use) the macOS keychain, the Windows credential manager or a Linux keyring.
  '--use-inmemory-secretstorage',
  '--use-mock-keychain',
  '--password-store=basic',
];

function instanceSettings(instance) {
  return {
    extensionDevelopmentPath: EXTENSION_TEST_EXTENSION,
    workspaceFolder: instance.workspace,
    env: extensionTestEnvironment(process.env, process.platform, instance, {
      VSCODE_DEPLOYMENT_EXTENSION_UNDER_TEST: EXTENSION_TEST_EXTENSION,
      VSCODE_DEPLOYMENT_CONFIG_DIR: instance.config,
      VSCODE_DEPLOYMENT_TEST_ROOT: instance.root,
      VSCODE_DEPLOYMENT_TEST_USER_DATA: instance.userData,
      VSCODE_DEPLOYMENT_TEST_EXTENSIONS_DIR: instance.extensions,
      // The leak test runs its helper with the Node.js that runs this file.
      VSCODE_DEPLOYMENT_TEST_NODE: process.execPath,
    }),
  };
}

const MOCHA = {
  ui: 'bdd',
  timeout: 120_000,
  forbidOnly: true,
  // Zero discovered tests is a failure, not a green run.
  failZero: true,
};

export default defineConfig([
  {
    label: 'main',
    // Not recursive: the leak test in canary/ needs its own instance (below).
    files: 'out/test/extension/*.test.js',
    // The minimum version from package.json `engines.vscode`.
    version: '1.144.0',
    ...instanceSettings(MAIN_INSTANCE),
    launchArgs: [
      ...ISOLATION_ARGS,
      `--user-data-dir=${MAIN_INSTANCE.userData}`,
      `--extensions-dir=${MAIN_INSTANCE.extensions}`,
    ],
    mocha: MOCHA,
  },
  {
    // The secret leak test (T7): trace logging, so that every log VS Code can write is
    // searched, and remote debugging, so that the passphrase is typed into the real input box.
    label: 'canary',
    files: 'out/test/extension/canary/*.test.js',
    version: '1.144.0',
    ...instanceSettings(CANARY_INSTANCE),
    launchArgs: [
      ...ISOLATION_ARGS,
      `--user-data-dir=${CANARY_INSTANCE.userData}`,
      `--extensions-dir=${CANARY_INSTANCE.extensions}`,
      '--log',
      'trace',
      '--remote-debugging-port=0',
    ],
    mocha: { ...MOCHA, timeout: 300_000 },
  },
]);
