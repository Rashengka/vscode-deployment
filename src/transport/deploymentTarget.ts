/**
 * What deployment commands need from a server. Upload, download and compare work only with
 * this interface, so that they do not depend on how the server is reached.
 *
 * This version has the read-only operations needed to connect and to check a server; writing
 * operations are added together with the commands that use them.
 */

export type RemoteEntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface RemoteStat {
  readonly type: RemoteEntryType;
  readonly size: number;
  /** Modification time in seconds since the epoch, as reported by the server. */
  readonly mtime: number;
  /** Permission bits (without the file type bits). */
  readonly mode: number;
}

export interface DeploymentTarget {
  /** A short description for messages, for example `deploy@example.com:22`. */
  describe(): string;
  /** The canonical absolute form of `path` on the server. */
  realpath(path: string): Promise<string>;
  /** Information about `path` (following symlinks), or `null` when it does not exist. */
  stat(path: string): Promise<RemoteStat | null>;
}
