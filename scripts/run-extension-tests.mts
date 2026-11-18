/**
 * Runs `vscode-test` (all instances, or those given with `--label`) and then checks that every
 * instance really ran its tests (see `scripts/lib/extensionTestResults.mts`): `vscode-test`
 * reports success when VS Code exits with code 0, even when mocha never ran.
 *
 * When an instance has no result, it lists the log files VS Code wrote (names and sizes only:
 * with `--log trace` VS Code logs its environment, and CI logs are public).
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
  createWriteStream,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import { join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { MochaOutputFilter } from './lib/extensionTestOutput.mts';
import {
  RESULTS_FILE,
  OUTPUT_FILE,
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
/**
 * The status flags of this process's stdout (`/proc/self/fdinfo/1`, Linux only) in octal: they
 * belong to the open pipe shared with the parent processes, so another process switching it to
 * O_NONBLOCK (04000) shows here.
 */
function stdoutFlags(): string | undefined {
  if (process.platform !== 'linux') {
    return undefined;
  }
  const flags = /^flags:\s+(\d+)$/m.exec(readFileSync('/proc/self/fdinfo/1', 'utf8'));
  return flags?.[1];
}
let lastFlags = stdoutFlags();
if (lastFlags !== undefined) {
  note(`stdout flags ${lastFlags}`);
}
let parentEnded = false;
const heartbeat = setInterval(() => {
  if (!parentEnded && process.ppid !== parentAtStart) {
    note(`parent ${parentAtStart} ended; new parent ${process.ppid}`);
    parentEnded = true;
  }
  const flags = stdoutFlags();
  if (flags !== lastFlags) {
    note(`stdout flags changed from ${lastFlags ?? 'none'} to ${flags ?? 'none'}`);
    lastFlags = flags;
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
// Not inherited: the test instances must not share our stdout (and the CI log) with VS Code.
// The full output goes to a file; the console gets only mocha's results (see the filter).
const outputFile = join(EXTENSION_TEST_ROOT, OUTPUT_FILE);
const output = createWriteStream(outputFile, { flags: 'a', mode: 0o600 });
const child = spawn(process.execPath, [cli, ...args], {
  cwd: REPO_ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
note(`vscode-test started: pid ${child.pid ?? 'none'}; its output goes to ${outputFile}`);
const filter = new MochaOutputFilter();
let hidden = 0;
for (const stream of [child.stdout, child.stderr]) {
  stream.pipe(output, { end: false });
  createInterface({ input: stream }).on('line', (line) => {
    const shown = filter.accept(line);
    if (shown === undefined) {
      hidden += 1;
    } else {
      console.log(shown);
    }
  });
}
const run = await new Promise<{ status: number | null }>((resolve, reject) => {
  child.once('error', reject);
  // 'close' comes after the output streams have ended, so every line has been handled.
  child.once('close', (status, signal) => {
    note(`vscode-test exited: code ${status ?? 'none'}, signal ${signal ?? 'none'}`);
    clearInterval(heartbeat);
    resolve({ status });
  });
});
output.end();
note(`${hidden} output lines of vscode-test were not shown (see ${OUTPUT_FILE})`);

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
  // Only names and sizes: the logs of the canary instance are trace logs with the environment.
  for (const file of filesBelow(logs)) {
    console.error(`  [${label}] log ${relative(logs, file)} (${statSync(file).size} bytes)`);
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
