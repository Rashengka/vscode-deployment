import { describe, expect, it } from 'vitest';
import { MAX_REMOTE_DEPTH } from '../../../src/settings/protocol';
import { RemoteBrowser, isUsableName } from '../../../src/settings/remoteBrowser';

const SESSION = 'b'.repeat(32);
const PAYLOAD = '<img src=x onerror=alert(1)>';

function browser(): RemoteBrowser {
  const picker = new RemoteBrowser('/home/deploy', SESSION);
  picker.record('', {
    entries: [
      { name: 'www', type: 'directory' },
      { name: 'current', type: 'symlink' },
      { name: 'notes.txt', type: 'file' },
      { name: PAYLOAD, type: 'directory' },
      { name: 'rtl\u202etxt.exe', type: 'directory' },
    ],
    truncated: false,
  });
  return picker;
}

describe('RemoteBrowser', () => {
  it('lists folders first, then files, by name, with sanitized labels', () => {
    const picker = new RemoteBrowser('/home/deploy', SESSION);
    const views = picker.record('', {
      entries: [
        { name: 'b.txt', type: 'file' },
        { name: 'zeta', type: 'directory' },
        { name: 'alpha', type: 'directory' },
        { name: 'bell\u0007', type: 'file' },
      ],
      truncated: false,
    });
    expect(views).toEqual([
      { name: 'alpha', label: 'alpha', kind: 'directory', usable: true },
      { name: 'zeta', label: 'zeta', kind: 'directory', usable: true },
      { name: 'b.txt', label: 'b.txt', kind: 'file', usable: true },
      // An unusable name is not sent back: it can never be part of a path.
      { name: '', label: 'bell\\x07', kind: 'file', usable: false },
    ]);
  });

  it('keeps a name like <img onerror> as it is: it is shown as text only', () => {
    const views = browser().record('', {
      entries: [{ name: PAYLOAD, type: 'directory' }],
      truncated: false,
    });
    expect(views[0]).toEqual({ name: PAYLOAD, label: PAYLOAD, kind: 'directory', usable: true });
  });

  it('opens the base folder and folders it listed, below the base only', () => {
    const picker = browser();
    expect(picker.folderPath('')).toBe('/home/deploy');
    expect(picker.folderPath('www')).toBe('/home/deploy/www');
    expect(picker.folderPath(PAYLOAD)).toBe(`/home/deploy/${PAYLOAD}`);
  });

  it.each([
    ['a parent folder', '..'],
    ['a path through the parent', 'www/../..'],
    ['an absolute path', '/etc'],
    ['a folder it did not list', 'etc'],
    ['a folder below one it did not list', 'www/html'],
    ['a symbolic link', 'current'],
    ['a file', 'notes.txt'],
    ['a name with a bidirectional override', 'rtl\u202etxt.exe'],
    ['an empty segment', 'www//'],
    ['a trailing slash', 'www/'],
    ['the current folder', '.'],
  ])('refuses %s', (_what, path) => {
    expect(browser().folderPath(path)).toBeNull();
  });

  it(`opens at most ${MAX_REMOTE_DEPTH} levels below the base`, () => {
    const picker = new RemoteBrowser('/', SESSION);
    let path = '';
    for (let depth = 0; depth <= MAX_REMOTE_DEPTH; depth++) {
      picker.record(path, { entries: [{ name: 'd', type: 'directory' }], truncated: false });
      path = path === '' ? 'd' : `${path}/d`;
    }
    const levels = (n: number): string => Array.from({ length: n }, () => 'd').join('/');
    expect(picker.folderPath(levels(MAX_REMOTE_DEPTH))).toBe(`/${levels(MAX_REMOTE_DEPTH)}`);
    expect(picker.folderPath(levels(MAX_REMOTE_DEPTH + 1))).toBeNull();
  });

  it('keeps the first entry of a name the server sent twice', () => {
    const picker = browser();
    const views = picker.record('', {
      entries: [
        { name: 'www', type: 'directory' },
        { name: 'www', type: 'file' },
      ],
      truncated: true,
    });
    expect(views).toEqual([{ name: 'www', label: 'www', kind: 'directory', usable: true }]);
    expect(picker.folderPath('www')).toBe('/home/deploy/www');
  });
});

describe('isUsableName', () => {
  it.each([
    ['index.php', true],
    ['with space', true],
    ['ünïcödé', true],
    [PAYLOAD, true],
    ['', false],
    ['.', false],
    ['..', false],
    ['a/b', false],
    ['a\\b', false],
    ['nul\u0000', false],
    ['line\nbreak', false],
    ['c1\u0085', false],
    ['zero\u200bwidth', false],
    ['grapheme\u034fjoiner', false],
    ['hangul\u115ffiller', false],
    ['variation\ufe0fselector', false],
    ['line\u2028separator', false],
    ['lone\ud800surrogate', false],
    ['x'.repeat(256), false],
  ])('%j -> %s', (name, usable) => {
    expect(isUsableName(name)).toBe(usable);
  });
});
