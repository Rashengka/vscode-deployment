/**
 * Runs `npm audit --json` and fails on any high or critical advisory that is not covered by a
 * dated exception in `scripts/lib/auditExceptions.mts`.
 *
 * Usage: node scripts/check-audit.mts
 */
import { spawnSync } from 'node:child_process';
import { AUDIT_EXCEPTIONS, evaluateAudit } from './lib/auditExceptions.mts';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// npm audit exits with 1 whenever it finds anything, so the exit code alone says nothing;
// the decision is made from the report.
const audit = spawnSync(npm, ['audit', '--json'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  shell: process.platform === 'win32',
});
if (audit.error !== undefined) {
  console.error(`npm audit could not be started: ${audit.error.message}`);
  process.exit(1);
}

let report: unknown;
try {
  report = JSON.parse(audit.stdout);
} catch {
  console.error(`npm audit did not return JSON (exit code ${String(audit.status)}).`);
  console.error(audit.stderr);
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
const { failures, tolerated, unused } = evaluateAudit(report, AUDIT_EXCEPTIONS, today);
for (const line of tolerated) {
  console.log(`::warning::Tolerated by a dated exception: ${line}`);
}
for (const line of unused) {
  console.log(`::notice::Audit exception no longer needed, remove it: ${line}`);
}
for (const line of failures) {
  console.error(`::error::${line}`);
}
console.log(failures.length === 0 ? 'Dependency audit passed.' : 'Dependency audit FAILED.');
process.exitCode = failures.length === 0 ? 0 : 1;
