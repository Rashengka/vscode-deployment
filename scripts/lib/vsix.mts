/**
 * Packaging helpers shared by `npm run package`, the integration tests and the extension tests.
 *
 * Unpacking uses the system `unzip` tool, which is available on Linux and macOS (the platforms
 * that run the packaging tests). The archive is always unpacked outside the repository, so that
 * Node.js module resolution cannot fall back to the development `node_modules`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const VSCE_CLI = join(REPO_ROOT, 'node_modules', '@vscode', 'vsce', 'vsce');

/** Builds the production bundle (via `vscode:prepublish`) and packages it into `outFile`. */
export function packageVsix(outFile: string): void {
  mkdirSync(dirname(outFile), { recursive: true });
  execFileSync(process.execPath, [VSCE_CLI, 'package', '--no-dependencies', '--out', outFile], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
}

export function listVsixEntries(vsixFile: string): string[] {
  const output = execFileSync('unzip', ['-Z1', vsixFile], { encoding: 'utf8' });
  return output.split('\n').filter((line) => line.length > 0);
}

/** Unpacks `vsixFile` into a fresh `targetDir`; returns the path of the extension folder. */
export function unpackVsix(vsixFile: string, targetDir: string): string {
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
  execFileSync('unzip', ['-q', vsixFile, '-d', targetDir], { stdio: 'inherit' });
  return join(targetDir, 'extension');
}
