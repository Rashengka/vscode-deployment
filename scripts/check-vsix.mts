/**
 * Lists the contents of a `.vsix` and fails when it contains anything outside the allowlist
 * (see `scripts/lib/vsixAllowlist.mts`) or misses a required file.
 *
 * Usage: node scripts/check-vsix.mts <file.vsix>
 */
import { pathToFileURL } from 'node:url';
import { checkVsixEntries } from './lib/vsixAllowlist.mts';
import { listVsixEntries } from './lib/vsix.mts';

export function verifyVsix(vsixFile: string): boolean {
  const entries = listVsixEntries(vsixFile);
  console.log(`Contents of ${vsixFile} (${entries.length} entries):`);
  for (const entry of entries) {
    console.log(`  ${entry}`);
  }

  const { disallowed, missing } = checkVsixEntries(entries);
  for (const entry of disallowed) {
    console.error(`Not allowed in the package: ${entry}`);
  }
  for (const entry of missing) {
    console.error(`Missing from the package: ${entry}`);
  }
  const ok = disallowed.length === 0 && missing.length === 0;
  console.log(ok ? 'Package contents match the allowlist.' : 'Package contents check FAILED.');
  return ok;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const vsixFile = process.argv[2];
  if (vsixFile === undefined) {
    console.error('Usage: node scripts/check-vsix.mts <file.vsix>');
    process.exitCode = 2;
  } else if (!verifyVsix(vsixFile)) {
    process.exitCode = 1;
  }
}
