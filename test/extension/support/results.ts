/**
 * Loaded by mocha in every VS Code instance before the tests (see `.vscode-test.mjs`). It
 * records that mocha started and, when every test has run, the counts, in the instance's test
 * folder. `scripts/run-extension-tests.mts` then fails the run when an instance has no result:
 * VS Code can exit with code 0 without ever running mocha, and `vscode-test` would report that
 * as a success. The file names match `scripts/lib/extensionTestResults.mts`.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STARTED_FILE = 'mocha-started.json';
const RESULTS_FILE = 'mocha-results.json';

function testRoot(): string {
  const root = process.env['VSCODE_DEPLOYMENT_TEST_ROOT'];
  if (root === undefined || root === '') {
    throw new Error('VSCODE_DEPLOYMENT_TEST_ROOT is not set');
  }
  return root;
}

interface Counts {
  passed: number;
  failed: number;
  pending: number;
  notRun: number;
}

function count(suite: Mocha.Suite, counts: Counts): void {
  for (const test of suite.tests) {
    if (test.isPending()) {
      counts.pending += 1;
    } else if (test.state === 'passed') {
      counts.passed += 1;
    } else if (test.state === 'failed') {
      counts.failed += 1;
    } else {
      counts.notRun += 1;
    }
  }
  // A failed `after`/`afterEach` hook leaves the tests passed; count it as a failure (mocha's
  // hook lists are not part of its public types).
  const hooks = suite as unknown as Record<
    '_beforeAll' | '_beforeEach' | '_afterEach' | '_afterAll',
    Mocha.Hook[] | undefined
  >;
  const all = [
    ...(hooks._beforeAll ?? []),
    ...(hooks._beforeEach ?? []),
    ...(hooks._afterEach ?? []),
    ...(hooks._afterAll ?? []),
  ];
  for (const hook of all) {
    if (hook.state === 'failed') {
      counts.failed += 1;
    }
  }
  for (const child of suite.suites) {
    count(child, counts);
  }
}

writeFileSync(join(testRoot(), STARTED_FILE), `${JSON.stringify({ started: true })}\n`);

after(function () {
  const root = this.test?.parent;
  const counts: Counts = { passed: 0, failed: 0, pending: 0, notRun: 0 };
  if (root !== undefined) {
    count(root, counts);
  }
  writeFileSync(join(testRoot(), RESULTS_FILE), `${JSON.stringify(counts)}\n`);
});
