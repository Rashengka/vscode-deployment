/**
 * Whether each VS Code instance of `npm run test:extension` really ran its tests.
 *
 * `vscode-test` reports success when VS Code exits with code 0, also when VS Code ended before
 * mocha ran a single test (`failZero` cannot help then: mocha never started). So every instance
 * writes two files into its test folder (`test/extension/support/results.ts`): one when the
 * test files are loaded and one with the counts when mocha has finished. A run is accepted only
 * when both exist for every instance and at least one test passed and none failed, was skipped
 * or did not run.
 */

/** Written when mocha loads the test files. */
export const STARTED_FILE = 'mocha-started.json';
/** Written when mocha has run every test. */
export const RESULTS_FILE = 'mocha-results.json';

export interface MochaCounts {
  readonly passed: number;
  readonly failed: number;
  readonly pending: number;
  /** Tests without a result, for example after a failed `before` hook. */
  readonly notRun: number;
}

export interface InstanceOutcome {
  readonly started: boolean;
  readonly results: MochaCounts | undefined;
}

/** The problems of a run, one message per problem; empty when the run is accepted. */
export function judgeExtensionTestRun(
  outcomes: Readonly<Record<string, InstanceOutcome>>,
): string[] {
  const problems: string[] = [];
  for (const [label, outcome] of Object.entries(outcomes)) {
    const { results } = outcome;
    if (results === undefined) {
      problems.push(
        outcome.started
          ? `${label}: the tests started but did not finish (no result from mocha).`
          : `${label}: the tests never started (no result from mocha).`,
      );
      continue;
    }
    if (results.passed <= 0) {
      problems.push(`${label}: no test passed.`);
    }
    if (results.failed > 0) {
      problems.push(`${label}: ${results.failed} test(s) failed.`);
    }
    if (results.pending > 0) {
      problems.push(`${label}: ${results.pending} test(s) were skipped.`);
    }
    if (results.notRun > 0) {
      problems.push(`${label}: ${results.notRun} test(s) did not run (a hook failed).`);
    }
  }
  return problems;
}

/** The labels selected with `--label`/`-l` (as `vscode-test` takes them), or all. */
export function labelsToCheck(args: readonly string[], all: readonly string[]): string[] {
  const selected: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if ((arg === '--label' || arg === '-l') && args[index + 1] !== undefined) {
      selected.push(args[index + 1] ?? '');
      index += 1;
    } else if (arg.startsWith('--label=')) {
      selected.push(arg.slice('--label='.length));
    }
  }
  return selected.length === 0 ? [...all] : selected;
}

/**
 * Written by `scripts/run-extension-tests.mts` into the extension test root as its very last
 * step, after it has judged every instance. A separate CI step checks it
 * (`scripts/check-extension-run.mts`): the test run itself can end with exit code 0 before it
 * gets that far, and then nothing in that process can report it.
 */
export const RUN_MARKER_FILE = 'run-complete.json';
/** The complete output of `vscode-test` (not shown: it contains what VS Code traces). */
export const OUTPUT_FILE = 'vscode-test-output.log';
/** Progress and signals of the test run (pids, exit codes, signal names; no environment). */
export const RUN_LOG_FILE = 'run.log';

export interface RunMarker {
  readonly labels: Readonly<Record<string, MochaCounts | null>>;
  readonly problems: readonly string[];
}

/** The problems of a finished run as its marker records it; `undefined` = no marker. */
export function judgeRunMarker(marker: unknown, required: readonly string[]): string[] {
  if (marker === undefined) {
    return ['the extension test run did not complete (no completion marker).'];
  }
  const record = marker as Partial<RunMarker>;
  if (typeof record.labels !== 'object' || !Array.isArray(record.problems)) {
    return ['the completion marker of the extension test run is not valid.'];
  }
  const problems = record.problems.map(String);
  for (const label of required) {
    if (!(label in record.labels) || record.labels[label] === null) {
      problems.push(`${label}: no result in the completion marker.`);
    }
  }
  return problems;
}
