/**
 * Fails unless the last `npm run test:extension` completed and judged every instance: it checks
 * the completion marker that `scripts/run-extension-tests.mts` writes as its very last step.
 * CI runs this as a separate step, so that it also catches a test run that ended (with exit
 * code 0) before it could report anything. Prints the run log (process ids, signals, exit
 * codes; no environment).
 *
 * Usage: node scripts/check-extension-run.mts [--label <label>]...
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RUN_LOG_FILE,
  RUN_MARKER_FILE,
  judgeRunMarker,
  labelsToCheck,
} from './lib/extensionTestResults.mts';
import { EXTENSION_TEST_INSTANCES, EXTENSION_TEST_ROOT } from './lib/extensionTestPaths.mts';

const required = labelsToCheck(process.argv.slice(2), Object.keys(EXTENSION_TEST_INSTANCES));
const log = join(EXTENSION_TEST_ROOT, RUN_LOG_FILE);
if (existsSync(log)) {
  console.log('Run log of the extension tests:');
  process.stdout.write(readFileSync(log, 'utf8'));
} else {
  console.log('The extension tests wrote no run log.');
}
const markerFile = join(EXTENSION_TEST_ROOT, RUN_MARKER_FILE);
const marker: unknown = existsSync(markerFile)
  ? JSON.parse(readFileSync(markerFile, 'utf8'))
  : undefined;
const problems = judgeRunMarker(marker, required);
for (const problem of problems) {
  console.error(`Extension tests: ${problem}`);
}
if (problems.length > 0) {
  process.exit(1);
}
console.log(`Extension tests completed for: ${required.join(', ')}`);
