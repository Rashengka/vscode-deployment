import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Runs scripts/check-leaks.mts against a throwaway repository, so that the commit scan is
// proven to fail on real commits, not only on strings passed to the pattern functions.

const SCRIPT = resolve(import.meta.dirname, '..', '..', 'scripts', 'check-leaks.mts');

// Sample leaks are assembled at runtime so that this file itself stays clean for the scan.
const SECRET_NAME = 'someone';
const macPath = ['', 'Users', SECRET_NAME, 'project'].join('/');
const slugName = ['notes', '', 'Users', SECRET_NAME, 'project.md'].join('-');

let repo: string;

function git(...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      '-c',
      `core.hooksPath=${join(repo, '.no-hooks')}`,
      ...args,
    ],
    { cwd: repo, encoding: 'utf8' },
  ).trim();
}

function commitFile(name: string, content: string, message: string): string {
  writeFileSync(join(repo, name), content);
  git('add', '--', name);
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
}

function scan(env: Record<string, string>): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, LEAK_SCAN_REPO: repo, LEAK_SCAN_BASE: '', LEAK_SCAN_HEAD: '', ...env },
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'vscode-deployment-leakscan-'));
  mkdirSync(join(repo, '.no-hooks'));
  git('init', '-q');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('check-leaks script over a commit range', () => {
  it('passes a clean history and reports how many commits it scanned', () => {
    commitFile('README.md', 'hello\n', 'docs: add readme');
    const head = commitFile('CHANGELOG.md', 'changes\n', 'docs: add changelog');

    const { status, output } = scan({ LEAK_SCAN_HEAD: head });

    expect(status).toBe(0);
    expect(output).toContain('Scanned 2 commit message(s)');
    expect(output).toContain('No leak patterns found.');
  });

  it('fails on a leak that exists only in a commit message, without printing it', () => {
    const head = commitFile('README.md', 'hello\n', `docs: copy from ${macPath}`);

    const { status, output } = scan({ LEAK_SCAN_HEAD: head });

    expect(status).toBe(1);
    expect(output).toContain(`commit ${head}: message matches leak pattern "macos-home"`);
    expect(output).not.toContain(SECRET_NAME);
  });

  it('fails on a file name that was committed and later deleted', () => {
    commitFile('README.md', 'hello\n', 'docs: add readme');
    const leaky = commitFile(slugName, 'note\n', 'docs: add note');
    git('rm', '-q', '--', slugName);
    git('commit', '-q', '-m', 'docs: remove note');
    const head = git('rev-parse', 'HEAD');

    const { status, output } = scan({ LEAK_SCAN_HEAD: head });

    expect(status).toBe(1);
    expect(output).toContain(`commit ${leaky}: a file name matches leak pattern "home-path-slug"`);
    expect(output).not.toContain(SECRET_NAME);
  });

  it('scans only the given range when the base commit is known', () => {
    const base = commitFile('README.md', 'hello\n', `docs: copy from ${macPath}`);
    const head = commitFile('CHANGELOG.md', 'changes\n', 'docs: add changelog');

    const { status, output } = scan({ LEAK_SCAN_BASE: base, LEAK_SCAN_HEAD: head });

    expect(status).toBe(0);
    expect(output).toContain('Scanned 1 commit message(s)');
  });

  it('falls back to the whole history when the base is the all-zero SHA', () => {
    const leaky = commitFile('README.md', 'hello\n', `docs: copy from ${macPath}`);
    const head = commitFile('CHANGELOG.md', 'changes\n', 'docs: add changelog');

    const { status, output } = scan({ LEAK_SCAN_BASE: '0'.repeat(40), LEAK_SCAN_HEAD: head });

    expect(status).toBe(1);
    expect(output).toContain(`commit ${leaky}: message matches leak pattern "macos-home"`);
  });
});
