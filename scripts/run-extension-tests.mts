/**
 * Runs `vscode-test` (all instances, or those given with `--label`) and then checks that every
 * instance really ran its tests (see `scripts/lib/extensionTestResults.mts`): `vscode-test`
 * reports success when VS Code exits with code 0, even when mocha never ran.
 *
 * When an instance has no result, it prints what VS Code logged about the extension host and
 * shutting down, filtered to short structural lines (never the environment: with `--log trace`
 * VS Code logs it, and CI logs are public).
 *
 * As its last step it writes a completion marker, which a separate CI step checks
 * (`scripts/check-extension-run.mts`), and it records its process ids, the signals it receives
 * and the exit of `vscode-test` in a run log, so that a run that ends early can be explained.
 *
 * Usage: node scripts/run-extension-tests.mts [--label <label>]...
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import { join, relative } from 'node:path';
import {
  RESULTS_FILE,
  RUN_LOG_FILE,
  RUN_MARKER_FILE,
  STARTED_FILE,
  judgeExtensionTestRun,
  labelsToCheck,
  type InstanceOutcome,
  type MochaCounts,
  type RunMarker,
} from './lib/extensionTestResults.mts';
import { EXTENSION_TEST_INSTANCES, EXTENSION_TEST_ROOT } from './lib/extensionTestPaths.mts';
import { REPO_ROOT } from './lib/vsix.mts';

const args = process.argv.slice(2);
const labels = labelsToCheck(args, Object.keys(EXTENSION_TEST_INSTANCES));

/** Appends a line to the run log and to stderr (process ids, codes and signal names only). */
function note(message: string): void {
  const line = `[run-extension-tests ${new Date().toISOString()}] ${message}`;
  appendFileSync(join(EXTENSION_TEST_ROOT, RUN_LOG_FILE), `${line}\n`);
  console.error(line);
}

/**
 * `pid ppid pgid sid command name` of a process, from `ps` (the command name only, never the
 * arguments or the environment); `undefined` when it does not exist (any more).
 */
function processInfo(pid: number): string | undefined {
  // macOS has no `sid` column; the command name is shortened to its last path part.
  const columns =
    process.platform === 'linux' ? 'pid=,ppid=,pgid=,sid=,comm=' : 'pid=,ppid=,pgid=,comm=';
  try {
    const fields = execFileSync('ps', ['-o', columns, '-p', String(pid)], { encoding: 'utf8' })
      .trim()
      .split(/\s+/);
    const numbers = columns.split(',').length - 1;
    const name = fields.slice(numbers).join(' ');
    return [...fields.slice(0, numbers), name.slice(name.lastIndexOf('/') + 1)].join(' ');
  } catch {
    // ps exits with 1 when the process does not exist.
    return undefined;
  }
}

/** This process and its ancestors up to the first process without a parent we can see. */
function ancestry(): string[] {
  const lines: string[] = [];
  let pid = process.pid;
  for (let depth = 0; depth < 12 && pid > 1; depth += 1) {
    const info = processInfo(pid);
    if (info === undefined) {
      break;
    }
    lines.push(info);
    pid = Number(info.split(' ')[1]);
  }
  return lines;
}

note(`started: pid ${process.pid}, parent ${process.ppid}`);
if (process.platform !== 'win32') {
  for (const line of ancestry()) {
    note(`  process (pid ppid pgid [sid] name): ${line}`);
  }
}
// Notices when the parent process ends while the tests run: this process is then reparented.
const parentAtStart = process.ppid;
const heartbeat = setInterval(() => {
  if (process.ppid !== parentAtStart) {
    note(`parent ${parentAtStart} ended; new parent ${process.ppid}`);
    clearInterval(heartbeat);
  }
}, 250);
const SIGNALS: readonly NodeJS.Signals[] =
  process.platform === 'win32'
    ? ['SIGINT', 'SIGTERM']
    : ['SIGTERM', 'SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGPIPE', 'SIGUSR1', 'SIGUSR2'];
for (const signal of SIGNALS) {
  process.on(signal, () => {
    note(`received ${signal}`);
    // A run that was interrupted never counts as passed.
    process.exit(128 + os.constants.signals[signal]);
  });
}
process.on('exit', (code) => {
  note(`exit with code ${code}`);
});

const cli = join(REPO_ROOT, 'node_modules', '@vscode', 'test-cli', 'out', 'bin.mjs');
const child = spawn(process.execPath, [cli, ...args], { cwd: REPO_ROOT, stdio: 'inherit' });
note(`vscode-test started: pid ${child.pid ?? 'none'}`);
const run = await new Promise<{ status: number | null }>((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (status, signal) => {
    note(`vscode-test exited: code ${status ?? 'none'}, signal ${signal ?? 'none'}`);
    clearInterval(heartbeat);
    resolve({ status });
  });
});

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
const marker: RunMarker = {
  labels: Object.fromEntries(
    Object.entries(outcomes).map(([label, outcome]) => [label, outcome.results ?? null]),
  ),
  problems: [...problems, ...(exitCode === 0 ? [] : [`vscode-test exited with code ${exitCode}.`])],
};
writeFileSync(join(EXTENSION_TEST_ROOT, RUN_MARKER_FILE), `${JSON.stringify(marker)}\n`);
process.exit(problems.length > 0 ? Math.max(exitCode, 1) : exitCode);
