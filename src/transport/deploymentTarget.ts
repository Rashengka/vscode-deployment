/**
 * What deployment commands need from a server. Upload, download and compare work only with
 * this interface, so that they do not depend on how the server is reached.
 *
 * This version has the read-only operations needed to connect, to check a server and to read
 * a file for Compare with Deployed Version; writing operations are added together with the
 * commands that use them.
 */

/**
 * The file is larger than the limit given to {@link DeploymentTarget.readFile}. Raised while
 * reading, after `maxBytes + 1` bytes at most, whatever size the server reports.
 */
export class RemoteFileTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`The file on the server is larger than ${maxBytes} bytes.`);
    this.name = 'RemoteFileTooLargeError';
    this.maxBytes = maxBytes;
  }
}

/**
 * The server did not send a file the way a server should, for example in more pieces than
 * {@link DeploymentTarget.readFile} accepts, so reading was stopped.
 */
export class RemoteReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteReadError';
  }
}

/** {@link DeploymentTarget.readFile} stopped because its signal was aborted. */
export class RemoteReadCancelledError extends Error {
  constructor() {
    super('Reading the file was cancelled.');
    this.name = 'RemoteReadCancelledError';
  }
}

export type RemoteEntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface RemoteStat {
  readonly type: RemoteEntryType;
  readonly size: number;
  /** Modification time in seconds since the epoch, as reported by the server. */
  readonly mtime: number;
  /** Permission bits (without the file type bits). */
  readonly mode: number;
}

export interface RemoteEntry {
  /** The name as the server sent it; untrusted (sanitize before showing it). */
  readonly name: string;
  /** The entry itself: a symbolic link is reported as `symlink`, not followed. */
  readonly type: RemoteEntryType;
}

export interface RemoteListing {
  readonly entries: readonly RemoteEntry[];
  /** The directory has more entries than were read. */
  readonly truncated: boolean;
}

export interface DeploymentTarget {
  /** A short description for messages, for example `deploy@example.com:22`. */
  describe(): string;
  /** The canonical absolute form of `path` on the server. */
  realpath(path: string): Promise<string>;
  /** Information about `path` (following symlinks), or `null` when it does not exist. */
  stat(path: string): Promise<RemoteStat | null>;
  /** Information about `path` itself: a symbolic link is reported as `symlink`, not followed. */
  lstat(path: string): Promise<RemoteStat | null>;
  /**
   * The content of the file `path`. Stops reading and fails with
   * {@link RemoteFileTooLargeError} as soon as it has more than `maxBytes`, with
   * {@link RemoteReadCancelledError} when `signal` is aborted, and with {@link RemoteReadError}
   * when the server sends the file in too many small pieces.
   */
  readFile(path: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer>;
  /** The entries of the directory `path` (without `.` and `..`), at most `maxEntries`. */
  readdir(path: string, maxEntries: number): Promise<RemoteListing>;
}
