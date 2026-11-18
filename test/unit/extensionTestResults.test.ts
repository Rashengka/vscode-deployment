import { describe, expect, it } from 'vitest';
import {
  judgeExtensionTestRun,
  labelsToCheck,
  type InstanceOutcome,
} from '../../scripts/lib/extensionTestResults.mts';

const ok: InstanceOutcome = {
  started: true,
  results: { passed: 5, failed: 0, pending: 0, notRun: 0 },
};

describe('judgeExtensionTestRun', () => {
  it('passes when every instance ran tests and none failed', () => {
    expect(judgeExtensionTestRun({ main: ok, canary: ok })).toEqual([]);
  });

  it('fails when an instance never started mocha (no result at all)', () => {
    expect(
      judgeExtensionTestRun({ main: ok, canary: { started: false, results: undefined } }),
    ).toEqual(['canary: the tests never started (no result from mocha).']);
  });

  it('fails when mocha started but did not finish', () => {
    expect(
      judgeExtensionTestRun({ main: ok, canary: { started: true, results: undefined } }),
    ).toEqual(['canary: the tests started but did not finish (no result from mocha).']);
  });

  it('fails without a passed test, with a failed one or with tests that did not run', () => {
    expect(
      judgeExtensionTestRun({
        main: { started: true, results: { passed: 0, failed: 0, pending: 0, notRun: 0 } },
        canary: { started: true, results: { passed: 3, failed: 1, pending: 0, notRun: 2 } },
      }),
    ).toEqual([
      'main: no test passed.',
      'canary: 1 test(s) failed.',
      'canary: 2 test(s) did not run (a hook failed).',
    ]);
  });

  it('fails for pending (skipped) tests', () => {
    expect(
      judgeExtensionTestRun({
        main: { started: true, results: { passed: 3, failed: 0, pending: 1, notRun: 0 } },
      }),
    ).toEqual(['main: 1 test(s) were skipped.']);
  });
});

describe('labelsToCheck', () => {
  it('checks every instance unless labels are given', () => {
    expect(labelsToCheck([], ['main', 'canary'])).toEqual(['main', 'canary']);
    expect(labelsToCheck(['--label', 'canary'], ['main', 'canary'])).toEqual(['canary']);
    expect(labelsToCheck(['-l', 'main', '--label=canary'], ['main', 'canary'])).toEqual([
      'main',
      'canary',
    ]);
  });
});
