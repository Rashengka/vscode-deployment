/**
 * Where the extension tests put the unpacked `.vsix`, the VS Code profiles, the workspaces, the
 * configuration roots and the temporary home directories. Both `.vscode-test.mjs` and
 * `scripts/prepare-extension-test.mts` import this module, so the paths cannot drift apart.
 *
 * Everything lives in one directory outside the repository (the tests must load the shipped
 * bundle; module resolution from inside the repository could fall back to the development
 * `node_modules`). Its name is derived from the checkout's path, so that several checkouts
 * (for example git worktrees) can run the extension tests at the same time without sharing
 * files. The names stay short because VS Code puts its IPC socket into the profile directory
 * and socket paths are limited to about 100 characters.
 *
 * There are two VS Code instances: `main` runs the ordinary extension tests and `canary` runs
 * only the secret leak test, with trace logging and remote debugging (see `.vscode-test.mjs`).
 * Each has its own profile, workspace, configuration root and home directory, so that the leak
 * test searches files written by its own instance only.
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

export interface ExtensionTestInstance {
  /** Directory of everything this instance writes (except the shared unpacked extension). */
  readonly root: string;
  /** VS Code profile (`--user-data-dir`); the logs are in its `logs` folder. */
  readonly userData: string;
  /** `--extensions-dir`; stays empty apart from what VS Code writes itself. */
  readonly extensions: string;
  /** Workspace folder opened by the instance. */
  readonly workspace: string;
  /**
   * Configuration root (passed as VSCODE_DEPLOYMENT_CONFIG_DIR), so that the tests never read or
   * write the configuration of the user running them.
   */
  readonly config: string;
  /** `HOME` (and `USERPROFILE`) of the instance; the user's own home is never visible to it. */
  readonly home: string;
  /** Parent of the `XDG_*_HOME` folders of the instance. */
  readonly xdg: string;
}

function instance(name: string): ExtensionTestInstance {
  const root = join(EXTENSION_TEST_ROOT, name);
  return {
    root,
    userData: join(root, 'ud'),
    extensions: join(root, 'ex'),
    workspace: join(root, 'ws'),
    config: join(root, 'cfg', 'vscode-deployment'),
    home: join(root, 'h'),
    xdg: join(root, 'x'),
  };
}

/** The instance that runs the ordinary extension tests. */
export const MAIN_INSTANCE = instance('m');

/** The instance that runs the secret leak test (trace logging, remote debugging). */
export const CANARY_INSTANCE = instance('c');

function createPrivateDirectory(path: string): void {
  // Not recursive: fails with EEXIST if anything appeared at this path in the meantime.
  mkdirSync(path, { mode: 0o700 });
  const stats = lstatSync(path);
  const owner = process.getuid?.();
  if (!stats.isDirectory() || (owner !== undefined && stats.uid !== owner)) {
    throw new Error(`${path} is not a directory owned by the current user.`);
  }
}

/**
 * Recreates {@link EXTENSION_TEST_ROOT} empty, as safely as `mkdtemp`: the directories are
 * created exclusively with mode 0700, so a directory or link that someone else put there in the
 * meantime makes this fail instead of being used.
 */
export function recreateExtensionTestRoot(): void {
  rmSync(EXTENSION_TEST_ROOT, { recursive: true, force: true });
  createPrivateDirectory(EXTENSION_TEST_ROOT);
  for (const { root, extensions, workspace, home, xdg } of [MAIN_INSTANCE, CANARY_INSTANCE]) {
    createPrivateDirectory(root);
    for (const dir of [extensions, workspace, home, xdg]) {
      createPrivateDirectory(dir);
    }
  }
}
