/**
 * Builds the production bundle, packages `vscode-deployment.vsix` in the repository root and
 * verifies that the archive contains nothing outside the `files` allowlist.
 *
 * A locally built package is for testing only; release packages are built in CI.
 *
 * Usage: node scripts/package.mts [--out <file.vsix>]
 */
import { join, resolve } from 'node:path';
import { REPO_ROOT, packageVsix } from './lib/vsix.mts';
import { verifyVsix } from './check-vsix.mts';

const outIndex = process.argv.indexOf('--out');
const outArg = outIndex === -1 ? undefined : process.argv[outIndex + 1];
const outFile = outArg === undefined ? join(REPO_ROOT, 'vscode-deployment.vsix') : resolve(outArg);

packageVsix(outFile);
if (!verifyVsix(outFile)) {
  process.exitCode = 1;
}
