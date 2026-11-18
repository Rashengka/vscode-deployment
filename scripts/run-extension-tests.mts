/**
 * Runs `vscode-test` (all instances, or those given with `--label`) and then checks that every
 * instance really ran its tests (see `scripts/lib/extensionTestResults.mts`): `vscode-test`
 * reports success when VS Code exits with code 0, even when mocha never ran.
 *
 * When an instance has no result, it prints what VS Code logged about the extension host and
 * shutting down, filtered to short structural lines (never the environment: with `--log trace`
 * VS Code logs it, and CI logs are public).
 *
 * Usage: node scripts/run-extension-tests.mts [--label <label>]...
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  RESULTS_FILE,
  STARTED_FILE,
  judgeExtensionTestRun,
  labelsToCheck,
  type InstanceOutcome,
  type MochaCounts,
} from './lib/extensionTestResults.mts';
import { EXTENSION_TEST_INSTANCES } from './lib/extensionTestPaths.mts';
import { REPO_ROOT } from './lib/vsix.mts';

const args = process.argv.slice(2);
const labels = labelsToCheck(args, Object.keys(EXTENSION_TEST_INSTANCES));

const cli = join(REPO_ROOT, 'node_modules', '@vscode', 'test-cli', 'out', 'bin.mjs');
const run = spawnSync(process.execPath, [cli, ...args], { cwd: REPO_ROOT, stdio: 'inherit' });
if (run.error !== undefined) {
  throw run.error;
}

function readCounts(file: string): MochaCounts | undefined {
  if (!existsSync(file)) {
    return undefined;
  }
  return JSON.parse(readFileSync(file, 'utf8')) as MochaCounts;
}

const outcomes: Record<string, InstanceOutcome> = {};
for (const label of labels) {
  const instance = EXTENSION_TEST_INSTANCES[label];
  if (instance === undefined) {
    throw new Error(`Unknown extension test label: ${label}`);
  }
  outcomes[label] = {
    started: existsSync(join(instance.root, STARTED_FILE)),
    results: readCounts(join(instance.root, RESULTS_FILE)),
  };
}

for (const [label, outcome] of Object.entries(outcomes)) {
  const counts = outcome.results;
  console.log(
    counts === undefined
      ? `Extension tests [${label}]: no result`
      : `Extension tests [${label}]: ${counts.passed} passed, ${counts.failed} failed, ` +
          `${counts.pending} skipped, ${counts.notRun} not run`,
  );
}

/** Lines about the extension host and shutting down; never lines that may carry variables. */
const STRUCTURAL =
  /extension ?host|exthost|terminat|crash|exit|lifecycle|quit|shutdown|unload|close|error/i;
const UNSAFE = /env|PATH|HOME|getUnixShell|VSCODE_TEST_OPTIONS|=|"[A-Z_]{3,}"/;

function filesBelow(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesBelow(path) : entry.isFile() ? [path] : [];
  });
}

function printDiagnostics(label: string): void {
  const instance = EXTENSION_TEST_INSTANCES[label];
  const logs = instance === undefined ? undefined : join(instance.userData, 'logs');
  if (logs === undefined || !existsSync(logs)) {
    console.error(`  [${label}] VS Code wrote no logs.`);
    return;
  }
  for (const file of filesBelow(logs)) {
    const name = relative(logs, file);
    console.error(`  [${label}] log ${name} (${statSync(file).size} bytes)`);
    if (!/(^|\/)(main|renderer|exthost|sharedprocess)\.log$/.test(name)) {
      continue;
    }
    const lines = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => STRUCTURAL.test(line) && !UNSAFE.test(line))
      .slice(-40);
    for (const line of lines) {
      console.error(`    ${line.slice(0, 200)}`);
    }
  }
}

const problems = judgeExtensionTestRun(outcomes);
for (const problem of problems) {
  console.error(`Extension tests: ${problem}`);
}
for (const [label, outcome] of Object.entries(outcomes)) {
  if (outcome.results === undefined) {
    printDiagnostics(label);
  }
}
const exitCode = run.status ?? 1;
process.exit(problems.length > 0 ? Math.max(exitCode, 1) : exitCode);
