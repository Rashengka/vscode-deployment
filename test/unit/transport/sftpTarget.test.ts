import type { SFTPWrapper } from 'ssh2';
import { describe, expect, it } from 'vitest';
import { ConnectionError } from '../../../src/ssh/connectionManager';
import {
  RemoteFileTooLargeError,
  RemoteReadCancelledError,
  RemoteReadError,
} from '../../../src/transport/deploymentTarget';
import { SftpTarget } from '../../../src/transport/sftpTarget';

type Callback = (error: Error | undefined, value?: unknown) => void;

/** An SFTP session whose every request fails with `error`. */
function failingSftp(error: Error): SFTPWrapper {
  const fail = (_path: string, callback: Callback): void => {
    callback(error);
  };
  return { realpath: fail, stat: fail } as unknown as SFTPWrapper;
}

describe('SftpTarget', () => {
  it('reports a closed SFTP channel as a connection error', async () => {
    const target = new SftpTarget(failingSftp(new Error('No response from server')), 'Prod');

    const failure = target.realpath('.').then(
      () => undefined,
      (error: unknown) => error,
    );

    const error = await failure;
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as Error).message).toBe(
      'The SFTP session to Prod ended: No response from server',
    );
    await expect(target.stat('/var/www/app')).rejects.toBeInstanceOf(ConnectionError);
  });

  it('keeps SFTP status errors of the server as they are', async () => {
    const status = Object.assign(new Error('Permission denied'), { code: 3 });
    const target = new SftpTarget(failingSftp(status), 'Prod');

    await expect(target.realpath('.')).rejects.toBe(status);
  });

  it('reports a missing file as null in stat', async () => {
    const missing = Object.assign(new Error('No such file'), { code: 2 });
    const target = new SftpTarget(failingSftp(missing), 'Prod');

    await expect(target.stat('/var/www/app/x')).resolves.toBeNull();
  });
});

interface FakeEntry {
  readonly filename: string;
  readonly kind: 'file' | 'directory' | 'symlink' | 'other';
}

function attrs(kind: FakeEntry['kind']): unknown {
  return {
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'directory',
    isSymbolicLink: () => kind === 'symlink',
  };
}

/** An SFTP session that returns one directory in batches, and records what it was asked. */
function directorySftp(batches: readonly (readonly FakeEntry[])[]): {
  sftp: SFTPWrapper;
  calls: string[];
} {
  const calls: string[] = [];
  let next = 0;
  const handle = Buffer.from('h1');
  const sftp = {
    opendir: (path: string, callback: (error: Error | undefined, handle?: Buffer) => void) => {
      calls.push(`opendir ${path}`);
      callback(undefined, handle);
    },
    readdir: (
      where: Buffer,
      callback: (error: Error | undefined, list?: { filename: string; attrs: unknown }[]) => void,
    ) => {
      calls.push(`readdir ${where.toString()}`);
      const batch = batches[next];
      next += 1;
      if (batch === undefined) {
        callback(Object.assign(new Error('EOF'), { code: 1 }));
        return;
      }
      callback(
        undefined,
        batch.map((entry) => ({ filename: entry.filename, attrs: attrs(entry.kind) })),
      );
    },
    close: (where: Buffer, callback: (error: Error | undefined) => void) => {
      calls.push(`close ${where.toString()}`);
      callback(undefined);
    },
  } as unknown as SFTPWrapper;
  return { sftp, calls };
}

describe('SftpTarget.readdir', () => {
  it('lists every batch of a directory with the type of each entry, without following links', async () => {
    const { sftp, calls } = directorySftp([
      [
        { filename: 'www', kind: 'directory' },
        { filename: 'index.php', kind: 'file' },
      ],
      [
        { filename: 'current', kind: 'symlink' },
        { filename: 'socket', kind: 'other' },
      ],
    ]);
    const listing = await new SftpTarget(sftp, 'Prod').readdir('/home/deploy', 100);
    expect(listing).toEqual({
      entries: [
        { name: 'www', type: 'directory' },
        { name: 'index.php', type: 'file' },
        { name: 'current', type: 'symlink' },
        { name: 'socket', type: 'other' },
      ],
      truncated: false,
    });
    expect(calls).toEqual([
      'opendir /home/deploy',
      'readdir h1',
      'readdir h1',
      'readdir h1',
      'close h1',
    ]);
  });

  it('stops reading at the limit, says so and closes the handle', async () => {
    const big = Array.from({ length: 50 }, (_, i) => ({
      filename: `f${i}`,
      kind: 'file' as const,
    }));
    const { sftp, calls } = directorySftp([big, big, big]);
    const listing = await new SftpTarget(sftp, 'Prod').readdir('/home/deploy', 60);
    expect(listing.entries).toHaveLength(60);
    expect(listing.truncated).toBe(true);
    expect(calls).toEqual(['opendir /home/deploy', 'readdir h1', 'readdir h1', 'close h1']);
  });

  it('drops the . and .. entries a server may send', async () => {
    const { sftp } = directorySftp([
      [
        { filename: '.', kind: 'directory' },
        { filename: '..', kind: 'directory' },
        { filename: 'a', kind: 'file' },
      ],
    ]);
    const listing = await new SftpTarget(sftp, 'Prod').readdir('/x', 10);
    expect(listing.entries).toEqual([{ name: 'a', type: 'file' }]);
  });

  it('keeps an SFTP status error of opendir as it is', async () => {
    const denied = Object.assign(new Error('Permission denied'), { code: 3 });
    const sftp = {
      opendir: (_path: string, callback: (error: Error) => void) => {
        callback(denied);
      },
    } as unknown as SFTPWrapper;
    await expect(new SftpTarget(sftp, 'Prod').readdir('/root', 10)).rejects.toBe(denied);
  });
});

describe('SftpTarget.readdir when the channel misbehaves', () => {
  /** A session whose `close` never answers, as on a channel that is gone. */
  function stuckSftp(read: (call: number) => { error?: Error; list?: string[] }): {
    sftp: SFTPWrapper;
    closes: number;
    reads: () => number;
  } {
    let call = 0;
    const state = { closes: 0 };
    const sftp = {
      opendir: (_path: string, callback: (error: Error | undefined, handle?: Buffer) => void) => {
        callback(undefined, Buffer.from('h'));
      },
      readdir: (
        _handle: Buffer,
        callback: (error: Error | undefined, list?: { filename: string; attrs: unknown }[]) => void,
      ) => {
        const answer = read(call);
        call += 1;
        callback(
          answer.error,
          answer.list?.map((filename) => ({ filename, attrs: attrs('file') })),
        );
      },
      close: () => {
        state.closes += 1;
      },
    } as unknown as SFTPWrapper;
    return {
      sftp,
      get closes() {
        return state.closes;
      },
      reads: () => call,
    };
  }

  it('fails at once when the channel fails in the middle, without waiting for close', async () => {
    const fake = stuckSftp((call) =>
      call === 0 ? { list: ['a'] } : { error: new Error('No response from server') },
    );
    await expect(new SftpTarget(fake.sftp, 'Prod').readdir('/x', 100)).rejects.toBeInstanceOf(
      ConnectionError,
    );
    expect(fake.closes).toBe(1);
  });

  it('answers at the end of the folder without waiting for close', async () => {
    const fake = stuckSftp((call) =>
      call === 0 ? { list: ['a'] } : { error: Object.assign(new Error('EOF'), { code: 1 }) },
    );
    await expect(new SftpTarget(fake.sftp, 'Prod').readdir('/x', 100)).resolves.toEqual({
      entries: [{ name: 'a', type: 'file' }],
      truncated: false,
    });
  });

  it('stops after a bounded number of empty batches and says that it stopped', async () => {
    const fake = stuckSftp(() => ({ list: [] }));
    const listing = await new SftpTarget(fake.sftp, 'Prod').readdir('/x', 10);
    expect(listing).toEqual({ entries: [], truncated: true });
    expect(fake.reads()).toBeLessThanOrEqual(20);
  });
});

/**
 * An SFTP session that serves one file of `content`, `chunk` bytes per read at most, answering
 * asynchronously like ssh2. It records the buffers it was asked to read into, and calls
 * `onRead` before answering each read.
 */
function fileSftp(
  content: Buffer,
  chunk: number,
  onRead: (reads: number) => void = () => undefined,
): {
  sftp: SFTPWrapper;
  calls: string[];
  requested: () => number;
  reads: () => number;
  bufferBytes: (extra?: ArrayBufferLike) => number;
} {
  const calls: string[] = [];
  let requested = 0;
  let reads = 0;
  const buffers = new Set<ArrayBufferLike>();
  const handle = Buffer.from('f1');
  const sftp = {
    open: (
      path: string,
      flags: string,
      callback: (error: Error | undefined, handle?: Buffer) => void,
    ) => {
      calls.push(`open ${path} ${flags}`);
      callback(undefined, handle);
    },
    read: (
      _where: Buffer,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
      callback: (error: Error | undefined, bytesRead?: number) => void,
    ) => {
      requested += length;
      reads += 1;
      buffers.add(buffer.buffer);
      onRead(reads);
      const end = Math.min(content.length, position + Math.min(length, chunk));
      const n = Math.max(0, end - position);
      content.copy(buffer, offset, position, position + n);
      // ssh2 reports the end of the file as a read of 0 bytes.
      setImmediate(() => {
        callback(undefined, n);
      });
    },
    close: (where: Buffer, callback: (error: Error | undefined) => void) => {
      calls.push(`close ${where.toString()}`);
      callback(undefined);
    },
  } as unknown as SFTPWrapper;
  return {
    sftp,
    calls,
    requested: () => requested,
    reads: () => reads,
    bufferBytes: (extra) =>
      [...new Set([...buffers, ...(extra === undefined ? [] : [extra])])].reduce(
        (sum, buffer) => sum + buffer.byteLength,
        0,
      ),
  };
}

describe('SftpTarget.readFile', () => {
  it('reads the whole file over several short reads and closes the handle', async () => {
    const content = Buffer.from('a'.repeat(10_000));
    const { sftp, calls } = fileSftp(content, 1000);
    const data = await new SftpTarget(sftp, 'Prod').readFile('/var/www/app/a.txt', 20_000);
    expect(data.equals(content)).toBe(true);
    expect(calls).toEqual(['open /var/www/app/a.txt r', 'close f1']);
  });

  it('reads an empty file', async () => {
    const { sftp } = fileSftp(Buffer.alloc(0), 1000);
    const data = await new SftpTarget(sftp, 'Prod').readFile('/var/www/app/empty', 10);
    expect(data.length).toBe(0);
  });

  it('reads a file of exactly the limit', async () => {
    const { sftp } = fileSftp(Buffer.alloc(100, 1), 7);
    const data = await new SftpTarget(sftp, 'Prod').readFile('/x', 100);
    expect(data.length).toBe(100);
  });

  it('stops reading one byte past the limit, whatever the size the server reported', async () => {
    const { sftp, calls, requested } = fileSftp(Buffer.alloc(1_000_000, 1), 64);
    const failure = await new SftpTarget(sftp, 'Prod').readFile('/x', 100).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RemoteFileTooLargeError);
    expect((failure as RemoteFileTooLargeError).maxBytes).toBe(100);
    // Never asked for more than the limit and one byte (to tell "exactly" from "more").
    expect(requested()).toBeLessThanOrEqual(101 + 64);
    expect(calls).toEqual(['open /x r', 'close f1']);
  });

  it('stops when the signal is aborted and closes the handle', async () => {
    const { sftp, calls } = fileSftp(Buffer.alloc(1000, 1), 10);
    const controller = new AbortController();
    controller.abort();
    await expect(
      new SftpTarget(sftp, 'Prod').readFile('/x', 10_000, controller.signal),
    ).rejects.toBeInstanceOf(RemoteReadCancelledError);
    expect(calls).toEqual(['open /x r', 'close f1']);
  });

  it('sends no further read once the signal is aborted during a read', async () => {
    const controller = new AbortController();
    const { sftp, calls, reads } = fileSftp(Buffer.alloc(1000, 1), 10, () => {
      controller.abort();
    });
    await expect(
      new SftpTarget(sftp, 'Prod').readFile('/x', 10_000, controller.signal),
    ).rejects.toBeInstanceOf(RemoteReadCancelledError);
    expect(reads()).toBe(1);
    expect(calls).toEqual(['open /x r', 'close f1']);
  });

  it('keeps memory near the data read when the server answers one byte per read', async () => {
    const content = Buffer.alloc(1000, 0x61);
    const { sftp, bufferBytes } = fileSftp(content, 1);
    const data = await new SftpTarget(sftp, 'Prod').readFile('/x', 1024 * 1024);
    expect(data.equals(content)).toBe(true);
    // Every buffer handed to the server and the buffer behind the result, together: at most
    // twice the data and one 64 KiB read buffer, not 64 KiB for every byte.
    expect(bufferBytes(data.buffer)).toBeLessThanOrEqual(2 * content.length + 64 * 1024 + 4096);
  });

  it('stops a server that sends a file in too many small pieces', async () => {
    const { sftp, calls, reads } = fileSftp(Buffer.alloc(1000, 0x61), 1);
    const failure = await new SftpTarget(sftp, 'Prod').readFile('/x', 2048).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RemoteReadError);
    expect((failure as Error).message).toMatch(/too many small pieces/);
    // maxBytes / 512, rounded up, and a reserve of 16.
    expect(reads()).toBe(Math.ceil(2049 / 512) + 16);
    expect(calls).toEqual(['open /x r', 'close f1']);
  });

  it('reads a large file in few requests from a server that answers in full', async () => {
    const content = Buffer.alloc(1024 * 1024, 0x62);
    const { sftp, reads } = fileSftp(content, 64 * 1024);
    const data = await new SftpTarget(sftp, 'Prod').readFile('/x', 2 * 1024 * 1024);
    expect(data.equals(content)).toBe(true);
    expect(reads()).toBeLessThanOrEqual(content.length / (64 * 1024) + 2);
  });

  it('keeps an SFTP status error of open as it is, and reports a closed channel', async () => {
    const denied = Object.assign(new Error('Permission denied'), { code: 3 });
    const failing = (error: Error): SFTPWrapper =>
      ({
        open: (_path: string, _flags: string, callback: (error: Error) => void) => {
          callback(error);
        },
      }) as unknown as SFTPWrapper;
    await expect(new SftpTarget(failing(denied), 'Prod').readFile('/x', 10)).rejects.toBe(denied);
    await expect(
      new SftpTarget(failing(new Error('No response from server')), 'Prod').readFile('/x', 10),
    ).rejects.toBeInstanceOf(ConnectionError);
  });
});

describe('SftpTarget.lstat', () => {
  function lstatSftp(answer: { error?: Error; kind?: FakeEntry['kind'] }): SFTPWrapper {
    return {
      lstat: (_path: string, callback: (error: Error | undefined, stats?: unknown) => void) => {
        if (answer.error !== undefined) {
          callback(answer.error);
          return;
        }
        callback(undefined, {
          ...(attrs(answer.kind ?? 'file') as object),
          size: 5,
          mtime: 1_700_000_000,
          mode: 0o120777,
        });
      },
    } as unknown as SFTPWrapper;
  }

  it('reports a symbolic link itself, not its target', async () => {
    const stat = await new SftpTarget(lstatSftp({ kind: 'symlink' }), 'Prod').lstat('/x');
    expect(stat).toEqual({ type: 'symlink', size: 5, mtime: 1_700_000_000, mode: 0o777 });
  });

  it('reports a missing path as null', async () => {
    const missing = Object.assign(new Error('No such file'), { code: 2 });
    await expect(
      new SftpTarget(lstatSftp({ error: missing }), 'Prod').lstat('/x'),
    ).resolves.toBeNull();
  });
});
