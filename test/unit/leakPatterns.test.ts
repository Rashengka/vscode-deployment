import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findLeaks, matchLeakPatterns } from '../../scripts/lib/leakPatterns.mts';

// Sample paths are assembled at runtime so that this file itself stays clean for the scan.
const mac = ['', 'Users', 'someone', 'project'].join('/');
const linux = ['', 'home', 'someone', '.ssh'].join('/');
const deployer = ['', 'home', 'deployer', 'app'].join('/');
const windows = ['C:', 'Users', 'someone'].join('\\');
const windowsJson = ['C:', 'Users', 'someone'].join('\\\\');
const windowsForward = ['c:', 'users', 'someone'].join('/');
const privateTmp = ['', 'private', 'tmp', 'scratch', 'file.txt'].join('/');
const varFolders = ['', 'var', 'folders', 'ab', 'xyz', 'T', 'file'].join('/');
const privateVarFolders = ['', 'private', 'var', 'folders', 'ab', 'xyz', 'T'].join('/');
const slug = ['scratch', '', 'Users', 'someone', 'project'].join('-');

function patternIds(content: string): string[] {
  return findLeaks('sample.txt', content).map((finding) => finding.patternId);
}

describe('matchLeakPatterns', () => {
  it('checks file names and commit messages with the same patterns', () => {
    expect(matchLeakPatterns(`docs/${slug}.md`)).toEqual(['home-path-slug']);
    expect(matchLeakPatterns(`fix: path in ${mac}`)).toEqual(['macos-home']);
    expect(matchLeakPatterns('feat: add upload command')).toEqual([]);
  });
});

describe('findLeaks', () => {
  it.each([
    ['a macOS home path', mac, 'macos-home'],
    ['a Linux home path', linux, 'linux-home'],
    ['a Linux home of a user whose name starts with deploy', deployer, 'linux-home'],
    ['a Windows profile path', windows, 'windows-home'],
    ['a JSON-escaped Windows profile path', windowsJson, 'windows-home'],
    ['a Windows profile path with forward slashes', windowsForward, 'windows-home'],
    ['a macOS temporary path', privateTmp, 'macos-private-tmp'],
    ['a macOS per-user temporary path', varFolders, 'macos-var-folders'],
    ['a macOS per-user temporary path below /private', privateVarFolders, 'macos-var-folders'],
    ['a home path encoded as a directory name', slug, 'home-path-slug'],
  ])('reports %s', (_name, content, expected) => {
    expect(patternIds(content)).toEqual([expected]);
  });

  it.each([
    ['the placeholder deploy home', 'rootPath: /home/deploy'],
    ['a path below the placeholder deploy home', '/home/deploy/www/app'],
    ['the placeholder web root', '/var/www/app'],
    ['an unrelated word', 'Users can upload files from the home screen.'],
    ['a plain temporary directory', '/tmp/vscode-deployment-it-abc'],
    ['a var path that is not a temporary folder', '/var/www/app/folders/x'],
  ])('accepts %s', (_name, content) => {
    expect(patternIds(content)).toEqual([]);
  });

  it('reports the line number but not the matched text', () => {
    const findings = findLeaks('notes.md', `first line\nsecond ${mac}\n`);
    expect(findings).toEqual([{ file: 'notes.md', line: 2, patternId: 'macos-home' }]);
  });

  it('does not match its own source file', () => {
    const source = readFileSync(
      new URL('../../scripts/lib/leakPatterns.mts', import.meta.url),
      'utf8',
    );
    expect(findLeaks('leakPatterns.mts', source)).toEqual([]);
  });
});
