/**
 * Where the extension tests put the unpacked `.vsix`, the VS Code profile, the workspace and the
 * configuration root. Both `.vscode-test.mjs` and `scripts/prepare-extension-test.mts` import
 * this module, so the paths cannot drift apart.
 *
 * Everything lives in one directory outside the repository (the tests must load the shipped
 * bundle; module resolution from inside the repository could fall back to the development
 * `node_modules`). Its name is derived from the checkout's path, so that several checkouts
 * (for example git worktrees) can run the extension tests at the same time without sharing
 * files. The name stays short because VS Code puts its IPC socket into the profile directory
 * and socket paths are limited to about 100 characters.
 */
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHECKOUT = realpathSync(resolve(import.meta.dirname, '..', '..'));
const CHECKOUT_ID = createHash('sha256').update(CHECKOUT).digest('hex').slice(0, 12);

/** The directory that holds everything below; one per checkout. */
export const EXTENSION_TEST_ROOT = join(tmpdir(), `vscode-deployment-${CHECKOUT_ID}`);

export const EXTENSION_TEST_DIR = join(EXTENSION_TEST_ROOT, 'ext');
export const EXTENSION_TEST_VSIX = join(EXTENSION_TEST_DIR, 'vscode-deployment.vsix');
export const EXTENSION_TEST_UNPACKED = join(EXTENSION_TEST_DIR, 'unpacked');
export const EXTENSION_TEST_EXTENSION = join(EXTENSION_TEST_UNPACKED, 'extension');

/** VS Code profile of the test instance. */
export const EXTENSION_TEST_USER_DATA = join(EXTENSION_TEST_ROOT, 'ud');

/** Workspace folder opened by the test instance. */
export const EXTENSION_TEST_WORKSPACE = join(EXTENSION_TEST_ROOT, 'ws');

/**
 * Configuration root of the test instance (passed as VSCODE_DEPLOYMENT_CONFIG_DIR), so that the
 * tests never read or write the configuration of the user running them.
 */
export const EXTENSION_TEST_CONFIG = join(EXTENSION_TEST_ROOT, 'cfg', 'vscode-deployment');

/**
 * Recreates {@link EXTENSION_TEST_ROOT} empty, as safely as `mkdtemp`: the directory is created
 * exclusively with mode 0700, so a directory or link that someone else put there in the
 * meantime makes this fail instead of being used.
 */
export function recreateExtensionTestRoot(): void {
  rmSync(EXTENSION_TEST_ROOT, { recursive: true, force: true });
  // Not recursive: fails with EEXIST if anything appeared at this path after the removal.
  mkdirSync(EXTENSION_TEST_ROOT, { mode: 0o700 });
  const stats = lstatSync(EXTENSION_TEST_ROOT);
  const owner = process.getuid?.();
  if (!stats.isDirectory() || (owner !== undefined && stats.uid !== owner)) {
    throw new Error(`${EXTENSION_TEST_ROOT} is not a directory owned by the current user.`);
  }
  mkdirSync(EXTENSION_TEST_WORKSPACE);
}
