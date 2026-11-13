/**
 * Packages the extension and unpacks it for `npm run test:extension`, which then runs the
 * extension tests against the unpacked `.vsix` instead of the development tree.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { verifyVsix } from './check-vsix.mts';
import {
  EXTENSION_TEST_CONFIG,
  EXTENSION_TEST_DIR,
  EXTENSION_TEST_UNPACKED,
  EXTENSION_TEST_USER_DATA,
  EXTENSION_TEST_VSIX,
  EXTENSION_TEST_WORKSPACE,
} from './lib/extensionTestPaths.mts';
import { REPO_ROOT, packageVsix, unpackVsix } from './lib/vsix.mts';

// Every run starts with a fresh package, a fresh VS Code profile and freshly compiled tests
// (stale files in out/ would otherwise still run).
rmSync(join(REPO_ROOT, 'out'), { recursive: true, force: true });
rmSync(EXTENSION_TEST_DIR, { recursive: true, force: true });
rmSync(EXTENSION_TEST_USER_DATA, { recursive: true, force: true });
// An empty workspace folder and no configuration, so that every run starts from scratch.
rmSync(EXTENSION_TEST_WORKSPACE, { recursive: true, force: true });
mkdirSync(EXTENSION_TEST_WORKSPACE, { recursive: true });
rmSync(dirname(EXTENSION_TEST_CONFIG), { recursive: true, force: true });
packageVsix(EXTENSION_TEST_VSIX);
if (!verifyVsix(EXTENSION_TEST_VSIX)) {
  throw new Error('The package contains files outside the allowlist.');
}
const extensionDir = unpackVsix(EXTENSION_TEST_VSIX, EXTENSION_TEST_UNPACKED);
console.log(`Extension tests will run against ${extensionDir}`);
