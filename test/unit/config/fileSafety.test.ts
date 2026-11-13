import { describe, expect, it } from 'vitest';
import { entryProblem, type EntryStat } from '../../../src/config/fileSafety';

const UID = 501;

function stat(
  kind: 'directory' | 'file' | 'link',
  mode: number,
  uid = UID,
  nlink = kind === 'directory' ? 3 : 1,
): EntryStat {
  return {
    isSymbolicLink: () => kind === 'link',
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    uid,
    mode,
    nlink,
  };
}

describe('entryProblem', () => {
  it.each([
    ['directory', '700', 0o40700],
    ['directory', '755', 0o40755],
    ['file', '600', 0o100600],
    ['file', '644', 0o100644],
  ] as const)('accepts a %s with mode %s owned by the user', (kind, _, mode) => {
    expect(entryProblem(stat(kind, mode), kind, UID)).toBeNull();
  });

  it('rejects symbolic links even when they point to the right kind', () => {
    expect(entryProblem(stat('link', 0o120777), 'directory', UID)).toBe('is a symbolic link');
    expect(entryProblem(stat('link', 0o120777), 'file', UID)).toBe('is a symbolic link');
  });

  it('rejects the wrong kind of entry', () => {
    expect(entryProblem(stat('file', 0o100600), 'directory', UID)).toBe('is not a folder');
    expect(entryProblem(stat('directory', 0o40700), 'file', UID)).toBe('is not a regular file');
  });

  it('rejects entries of another user', () => {
    expect(entryProblem(stat('directory', 0o40700, 0), 'directory', UID)).toBe(
      'belongs to another user',
    );
  });

  it.each([
    ['770', 0o40770],
    ['707', 0o40707],
    ['720', 0o40720],
    ['702', 0o40702],
    ['777', 0o40777],
  ])('rejects a folder writable by others (mode %s)', (_, mode) => {
    expect(entryProblem(stat('directory', mode), 'directory', UID)).toMatch(
      /^is writable by other users \(mode \d{3}\)$/,
    );
  });

  it('rejects a file with a second hard link, but not a folder (folders always have several)', () => {
    expect(entryProblem(stat('file', 0o100600, UID, 2), 'file', UID)).toBe(
      'has more than one hard link',
    );
    expect(entryProblem(stat('directory', 0o40700, UID, 5), 'directory', UID)).toBeNull();
  });

  it('rejects a file writable by others', () => {
    expect(entryProblem(stat('file', 0o100666), 'file', UID)).toBe(
      'is writable by other users (mode 666)',
    );
  });
});
