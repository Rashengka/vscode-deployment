import type { SFTPWrapper } from 'ssh2';
import { describe, expect, it } from 'vitest';
import { ConnectionError } from '../../../src/ssh/connectionManager';
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
