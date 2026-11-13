/**
 * Scans the repository for generic leak patterns (see `scripts/lib/leakPatterns.mts`):
 *
 * 1. the content and the name of every file in the working tree that git tracks (plus untracked
 *    files that are not ignored),
 * 2. when `LEAK_SCAN_HEAD` is set, the message and the changed file names of every commit in
 *    `LEAK_SCAN_BASE..LEAK_SCAN_HEAD`. A missing, all-zero or unknown base (new branch, force
 *    push, manual run) scans the whole history of the head commit instead.
 *
 * Output names the file or commit and the pattern id, never the matched text, so that a report
 * in a public CI log does not repeat the leak. Files containing NUL bytes are treated as binary;
 * they are listed and counted, not scanned. Exit codes: 1 = findings, 2 = nothing was scanned or
 * invalid input.
 *
 * Usage: [LEAK_SCAN_BASE=<sha>] [LEAK_SCAN_HEAD=<sha>] node scripts/check-leaks.mts
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findLeaks, matchLeakPatterns } from './lib/leakPatterns.mts';
import { REPO_ROOT } from './lib/vsix.mts';

const SHA = /^[0-9a-f]{40}$/;
const ZERO_SHA = /^0{40}$/;

function git(args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

function nulSeparated(output: string): string[] {
  return output.split('\0').filter((item) => item.length > 0);
}

const problems: string[] = [];

// 1. Working tree.
const files = nulSeparated(
  git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']),
).filter((file) => existsSync(join(REPO_ROOT, file)));

let scannedFiles = 0;
let scannedBytes = 0;
const binaryFiles: string[] = [];
for (const [index, file] of files.entries()) {
  for (const patternId of matchLeakPatterns(file)) {
    problems.push(`file name #${index + 1} of git ls-files: matches leak pattern "${patternId}"`);
  }
  const content = readFileSync(join(REPO_ROOT, file));
  if (content.includes(0)) {
    binaryFiles.push(file);
    continue;
  }
  scannedFiles += 1;
  scannedBytes += content.length;
  for (const finding of findLeaks(file, content.toString('utf8'))) {
    problems.push(`${finding.file}:${finding.line}: matches leak pattern "${finding.patternId}"`);
  }
}
console.log(`Scanned ${scannedFiles} of ${files.length} files (${scannedBytes} bytes).`);
if (binaryFiles.length > 0) {
  console.log(`Skipped ${binaryFiles.length} binary file(s), content not scanned:`);
  for (const file of binaryFiles) {
    console.log(`  ${file}`);
  }
}
if (scannedFiles === 0 || scannedBytes === 0) {
  console.error('Nothing was scanned; refusing to report a clean result.');
  process.exit(2);
}

// 2. Commit range (CI passes the refs through the environment).
const head = process.env['LEAK_SCAN_HEAD'] ?? '';
const base = process.env['LEAK_SCAN_BASE'] ?? '';
if (head !== '') {
  if (!SHA.test(head) || (base !== '' && !SHA.test(base))) {
    console.error('LEAK_SCAN_HEAD and LEAK_SCAN_BASE must be full commit SHAs.');
    process.exit(2);
  }
  const baseKnown =
    base !== '' &&
    !ZERO_SHA.test(base) &&
    spawnSync('git', ['cat-file', '-e', `${base}^{commit}`], { cwd: REPO_ROOT }).status === 0;
  const range = baseKnown ? [`${base}..${head}`] : [head];
  console.log(
    baseKnown
      ? `Scanning commits ${base.slice(0, 12)}..${head.slice(0, 12)}.`
      : `No usable base commit; scanning the whole history of ${head.slice(0, 12)}.`,
  );

  const commits = git(['rev-list', ...range])
    .split('\n')
    .filter((sha) => sha.length > 0);
  for (const commit of commits) {
    const message = git(['log', '-1', '--format=%B', commit]);
    for (const patternId of matchLeakPatterns(message)) {
      problems.push(`commit ${commit}: message matches leak pattern "${patternId}"`);
    }
    const changedNames = nulSeparated(
      git(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--root', '-m', commit]),
    );
    for (const name of changedNames) {
      for (const patternId of matchLeakPatterns(name)) {
        problems.push(`commit ${commit}: a file name matches leak pattern "${patternId}"`);
      }
    }
  }
  console.log(`Scanned ${commits.length} commit message(s) and their file names.`);
}

for (const problem of problems) {
  console.error(problem);
}
if (problems.length > 0) {
  console.error(`${problems.length} potential leak(s) found.`);
  process.exitCode = 1;
} else {
  console.log('No leak patterns found.');
}
