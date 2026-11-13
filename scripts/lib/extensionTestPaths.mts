/**
 * Where the extension tests unpack the `.vsix`. It is outside the repository on purpose: the
 * tests must load the shipped bundle, and Node.js module resolution from a folder inside the
 * repository could fall back to the development `node_modules`.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const EXTENSION_TEST_DIR = join(tmpdir(), 'vscode-deployment-extension-test');
export const EXTENSION_TEST_VSIX = join(EXTENSION_TEST_DIR, 'vscode-deployment.vsix');
export const EXTENSION_TEST_UNPACKED = join(EXTENSION_TEST_DIR, 'unpacked');
export const EXTENSION_TEST_EXTENSION = join(EXTENSION_TEST_UNPACKED, 'extension');

/**
 * VS Code profile of the test instance. Short on purpose: VS Code puts its IPC socket there and
 * socket paths are limited to about 100 characters.
 */
export const EXTENSION_TEST_USER_DATA = join(tmpdir(), 'vscode-deployment-ud');
