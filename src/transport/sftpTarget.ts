/** {@link DeploymentTarget} over an SFTP session of an SSH connection. */
import type { SFTPWrapper, Stats } from 'ssh2';
import { ConnectionError } from '../ssh/connectionError';
import type {
  DeploymentTarget,
  RemoteEntry,
  RemoteEntryType,
  RemoteListing,
  RemoteStat,
} from './deploymentTarget';

/** SFTP status codes (draft-ietf-secsh-filexfer): SSH_FX_EOF and SSH_FX_NO_SUCH_FILE. */
const END_OF_FILE = 1;
const NO_SUCH_FILE = 2;

/**
 * SFTP status errors carry the server's numeric status code and are returned as they are.
 * Anything else means the SFTP channel itself failed (closed, no response from the server);
 * that becomes a {@link ConnectionError}, so that callers can tell it from a bug.
 */
function channelError(error: Error, description: string): Error {
  if (typeof (error as Error & { code?: unknown }).code === 'number') {
    return error;
  }
  return new ConnectionError(`The SFTP session to ${description} ended: ${error.message}`);
}

function statusCode(error: Error): unknown {
  return (error as Error & { code?: unknown }).code;
}

function entryType(
  stats: Pick<Stats, 'isFile' | 'isDirectory' | 'isSymbolicLink'>,
): RemoteEntryType {
  if (stats.isFile()) {
    return 'file';
  }
  if (stats.isDirectory()) {
    return 'directory';
  }
  return stats.isSymbolicLink() ? 'symlink' : 'other';
}

export class SftpTarget implements DeploymentTarget {
  private readonly sftp: SFTPWrapper;
  private readonly description: string;

  constructor(sftp: SFTPWrapper, description: string) {
    this.sftp = sftp;
    this.description = description;
  }

  describe(): string {
    return this.description;
  }

  realpath(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.sftp.realpath(path, (error, absolute) => {
        if (error instanceof Error) {
          reject(channelError(error, this.description));
        } else {
          resolve(absolute);
        }
      });
    });
  }

  stat(path: string): Promise<RemoteStat | null> {
    return new Promise((resolve, reject) => {
      this.sftp.stat(path, (error, stats) => {
        if (!(error instanceof Error)) {
          resolve({
            type: entryType(stats),
            size: stats.size,
            mtime: stats.mtime,
            mode: stats.mode & 0o7777,
          });
        } else if ((error as Error & { code?: unknown }).code === NO_SUCH_FILE) {
          resolve(null);
        } else {
          reject(channelError(error, this.description));
        }
      });
    });
  }

  /**
   * Reads the directory batch by batch through its handle, so that a directory with a huge
   * number of entries is not read beyond `maxEntries` (the server decides how large a batch
   * is), and a server that keeps sending empty batches is not read beyond a bounded number of
   * them. The answer never waits for the handle to close: on a channel that is gone, `close`
   * never calls back.
   */
  readdir(path: string, maxEntries: number): Promise<RemoteListing> {
    const maxBatches = maxEntries + 2;
    return new Promise((resolve, reject) => {
      this.sftp.opendir(path, (openError, handle) => {
        if (openError instanceof Error) {
          reject(channelError(openError, this.description));
          return;
        }
        const entries: RemoteEntry[] = [];
        let batches = 0;
        const finish = (outcome: () => void): void => {
          outcome();
          // Closing a handle after reading cannot change the listing; its answer is not awaited.
          this.sftp.close(handle, () => undefined);
        };
        const next = (): void => {
          this.sftp.readdir(handle, (readError, list) => {
            if (readError instanceof Error) {
              if (statusCode(readError) === END_OF_FILE) {
                finish(() => {
                  resolve({ entries, truncated: false });
                });
              } else {
                finish(() => {
                  reject(channelError(readError, this.description));
                });
              }
              return;
            }
            batches += 1;
            for (const item of list) {
              if (item.filename !== '.' && item.filename !== '..') {
                entries.push({ name: item.filename, type: entryType(item.attrs) });
              }
            }
            if (entries.length > maxEntries || batches >= maxBatches) {
              finish(() => {
                resolve({ entries: entries.slice(0, maxEntries), truncated: true });
              });
            } else {
              next();
            }
          });
        };
        next();
      });
    });
  }
}
