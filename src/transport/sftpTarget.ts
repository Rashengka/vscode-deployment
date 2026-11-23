/** {@link DeploymentTarget} over an SFTP session of an SSH connection. */
import type { SFTPWrapper, Stats } from 'ssh2';
import { ConnectionError } from '../ssh/connectionError';
import {
  RemoteFileTooLargeError,
  RemoteReadCancelledError,
  RemoteReadError,
  type DeploymentTarget,
  type RemoteEntry,
  type RemoteEntryType,
  type RemoteListing,
  type RemoteStat,
} from './deploymentTarget';

/** SFTP status codes (draft-ietf-secsh-filexfer): SSH_FX_EOF and SSH_FX_NO_SUCH_FILE. */
const END_OF_FILE = 1;
const NO_SUCH_FILE = 2;

/** Bytes asked for in one read request; ssh2 splits larger requests itself. */
const READ_CHUNK = 64 * 1024;

/**
 * Read requests allowed per file: one per {@link MIN_PIECE} bytes of the limit and a reserve.
 * A server that answers every request with a byte or two would otherwise make millions of
 * round trips before the size limit is reached.
 */
const MIN_PIECE = 512;
const READ_RESERVE = 16;

export function maxReadRequests(maxBytes: number): number {
  return Math.ceil((maxBytes + 1) / MIN_PIECE) + READ_RESERVE;
}

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

/** The first `length` bytes of `buffer`, copied when they use less than half of it. */
function compact(buffer: Buffer, length: number): Buffer {
  if (length * 2 >= buffer.length) {
    return buffer.subarray(0, length);
  }
  const copy = Buffer.alloc(length);
  buffer.copy(copy, 0, 0, length);
  return copy;
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
    return this.statWith('stat', path);
  }

  lstat(path: string): Promise<RemoteStat | null> {
    return this.statWith('lstat', path);
  }

  private statWith(method: 'stat' | 'lstat', path: string): Promise<RemoteStat | null> {
    return new Promise((resolve, reject) => {
      this.sftp[method](path, (error, stats) => {
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
   * Reads the file through its handle, request by request, into one buffer that grows by
   * doubling up to `maxBytes + 1` bytes: the limit holds whatever size the server reports, one
   * byte more than the limit tells a file of exactly `maxBytes` from a larger one, and the
   * memory used stays within twice the data read (and one read request), also when the server
   * answers every request with a single byte. The number of requests is limited as well
   * ({@link maxReadRequests}). Like {@link readdir}, the answer never waits for the handle to
   * close.
   */
  readFile(path: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
    const capacityLimit = maxBytes + 1;
    const maxRequests = maxReadRequests(maxBytes);
    return new Promise((resolve, reject) => {
      this.sftp.open(path, 'r', (openError, handle) => {
        if (openError instanceof Error) {
          reject(channelError(openError, this.description));
          return;
        }
        const finish = (outcome: () => void): void => {
          outcome();
          // Closing a handle after reading cannot change what was read.
          this.sftp.close(handle, () => undefined);
        };
        let buffer = Buffer.alloc(Math.min(READ_CHUNK, capacityLimit));
        let length = 0;
        let requests = 0;
        const next = (): void => {
          if (signal?.aborted === true) {
            finish(() => {
              reject(new RemoteReadCancelledError());
            });
            return;
          }
          if (requests >= maxRequests) {
            finish(() => {
              reject(
                new RemoteReadError(
                  `The server sent the file in too many small pieces (more than ${maxRequests} ` +
                    'read requests), so reading was stopped.',
                ),
              );
            });
            return;
          }
          if (length === buffer.length) {
            const grown = Buffer.alloc(Math.min(buffer.length * 2, capacityLimit));
            buffer.copy(grown, 0, 0, length);
            buffer = grown;
          }
          requests += 1;
          const wanted = Math.min(READ_CHUNK, buffer.length - length);
          this.sftp.read(handle, buffer, length, wanted, length, (readError, bytesRead) => {
            if (readError instanceof Error) {
              finish(() => {
                reject(channelError(readError, this.description));
              });
              return;
            }
            if (bytesRead === 0) {
              finish(() => {
                resolve(compact(buffer, length));
              });
              return;
            }
            length += bytesRead;
            if (length > maxBytes) {
              finish(() => {
                reject(new RemoteFileTooLargeError(maxBytes));
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
