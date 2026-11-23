import { describe, expect, it } from 'vitest';
import {
  BINARY_SNIFF_BYTES,
  MAX_COMPARE_BYTES,
  fetchDeployedVersion,
  looksBinary,
} from '../../../src/compare/fetch';
import {
  RemoteFileTooLargeError,
  type DeploymentTarget,
  type RemoteStat,
} from '../../../src/transport/deploymentTarget';

describe('looksBinary', () => {
  it('finds a NUL byte in the first 8 kB only', () => {
    expect(BINARY_SNIFF_BYTES).toBe(8192);
    expect(looksBinary(Buffer.from('plain text\n'))).toBe(false);
    expect(looksBinary(Buffer.alloc(0))).toBe(false);
    expect(looksBinary(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]))).toBe(true);
    const late = Buffer.alloc(BINARY_SNIFF_BYTES + 1, 0x61);
    late[BINARY_SNIFF_BYTES] = 0;
    expect(looksBinary(late)).toBe(false);
    late[BINARY_SNIFF_BYTES - 1] = 0;
    expect(looksBinary(late)).toBe(true);
  });

  it('does not take UTF-8 text for binary', () => {
    expect(looksBinary(Buffer.from('Příliš žluťoučký kůň ↔ 日本語', 'utf8'))).toBe(false);
  });
});

const file: RemoteStat = { type: 'file', size: 5, mtime: 1_700_000_000, mode: 0o644 };

function target(
  stat: RemoteStat | null,
  read: () => Promise<Buffer> = () => Promise.resolve(Buffer.from('hello')),
): { target: Pick<DeploymentTarget, 'lstat' | 'readFile'>; reads: unknown[][] } {
  const reads: unknown[][] = [];
  return {
    reads,
    target: {
      lstat: () => Promise.resolve(stat),
      readFile: (...args: unknown[]) => {
        reads.push(args);
        return read();
      },
    },
  };
}

describe('fetchDeployedVersion', () => {
  it('reads a text file with the 20 MB limit', async () => {
    expect(MAX_COMPARE_BYTES).toBe(20 * 1024 * 1024);
    const { target: t, reads } = target(file);
    const result = await fetchDeployedVersion(t, '/home/deploy/a.txt');
    expect(result).toEqual({ kind: 'text', content: Buffer.from('hello'), stat: file });
    expect(reads[0]?.slice(0, 2)).toEqual(['/home/deploy/a.txt', MAX_COMPARE_BYTES]);
  });

  it('reports a missing file without reading', async () => {
    const { target: t, reads } = target(null);
    expect(await fetchDeployedVersion(t, '/x')).toEqual({ kind: 'missing' });
    expect(reads).toHaveLength(0);
  });

  it('refuses a symbolic link on the server without reading it', async () => {
    const { target: t, reads } = target({ ...file, type: 'symlink' });
    expect(await fetchDeployedVersion(t, '/x')).toEqual({ kind: 'symlink' });
    expect(reads).toHaveLength(0);
  });

  it('refuses a directory or a special file without reading it', async () => {
    const dir = target({ ...file, type: 'directory' });
    expect(await fetchDeployedVersion(dir.target, '/x')).toEqual({
      kind: 'notFile',
      type: 'directory',
    });
    const other = target({ ...file, type: 'other' });
    expect(await fetchDeployedVersion(other.target, '/x')).toEqual({
      kind: 'notFile',
      type: 'other',
    });
    expect(dir.reads.length + other.reads.length).toBe(0);
  });

  it('reports a file over the limit even when the server claims it is small', async () => {
    const { target: t } = target(file, () => Promise.reject(new RemoteFileTooLargeError(10)));
    expect(await fetchDeployedVersion(t, '/x', 10)).toEqual({ kind: 'tooLarge', maxBytes: 10 });
  });

  it('reports a binary file instead of its content', async () => {
    const { target: t } = target(file, () => Promise.resolve(Buffer.from([1, 0, 2])));
    expect(await fetchDeployedVersion(t, '/x')).toEqual({ kind: 'binary', size: 3 });
  });

  it('passes other errors on', async () => {
    const denied = Object.assign(new Error('Permission denied'), { code: 3 });
    const { target: t } = target(file, () => Promise.reject(denied));
    await expect(fetchDeployedVersion(t, '/x')).rejects.toBe(denied);
  });

  it('reports a file deleted between lstat and the read as missing', async () => {
    const gone = Object.assign(new Error('No such file'), { code: 2 });
    const { target: t } = target(file, () => Promise.reject(gone));
    expect(await fetchDeployedVersion(t, '/x')).toEqual({ kind: 'missing' });
  });
});
