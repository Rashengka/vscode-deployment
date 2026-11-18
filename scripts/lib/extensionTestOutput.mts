/**
 * Which lines of the `vscode-test` output may go to the console (and so to the public CI log).
 *
 * The output of the test instances mixes mocha's results with everything VS Code prints, and
 * with `--log trace` VS Code prints its environment (and the shell environment it resolves).
 * The full output therefore goes to a file only (`scripts/run-extension-tests.mts`), and the
 * console gets the lines this filter accepts. It is an allowlist of the shapes of mocha's spec
 * reporter (and of the summary lines of the leak test); anything else is dropped, so a new kind
 * of VS Code output can never reach the CI log by accident.
 */

// eslint-disable-next-line no-control-regex -- removing terminal color codes is the point
const COLORS = /\u001b\[[0-9;]*m/g;

/** Lines that are always accepted. */
const RESULT_LINES: readonly RegExp[] = [
  /^\s+[✔✓] \S.*$/u,
  /^\s+\d+\) \S.*$/,
  /^\s{4,}- \S.*$/,
  /^\s+\d+ (passing|failing|pending)( \(\d+(ms|s|m)\))?$/,
  /^Exit code:\s+\S+$/,
  /^\s+\w+: \d+ files, \d+ bytes, \d+ lines$/,
  /^\s+decrypted key in the heap while connected: (yes|no)$/,
];

/** Lines of mocha's failure reports, accepted between "N failing" and the next exit code. */
const FAILURE_LINES: readonly RegExp[] = [
  /^\s{5,}\S.*:$/,
  /^\s+(?:[A-Z][A-Za-z]*)?Error\b.*$/,
  /^\s+at \S.*$/,
  /^\s+\+ expected - actual$/,
  /^\s{4,}[+-]\S.*$/,
];

export class MochaOutputFilter {
  private inFailures = false;

  /** The line without colors when it may be shown, `undefined` when not. */
  accept(raw: string): string | undefined {
    const line = raw.replace(COLORS, '').replace(/\r$/, '');
    if (/^\s+\d+ failing$/.test(line)) {
      this.inFailures = true;
      return line;
    }
    if (/^Exit code:/.test(line)) {
      this.inFailures = false;
    }
    if (RESULT_LINES.some((shape) => shape.test(line))) {
      return line;
    }
    if (this.inFailures && FAILURE_LINES.some((shape) => shape.test(line))) {
      return line;
    }
    return undefined;
  }
}
