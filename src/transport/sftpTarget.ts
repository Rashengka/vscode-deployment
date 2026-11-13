/** {@link DeploymentTarget} over an SFTP session of an SSH connection. */
import type { SFTPWrapper, Stats } from 'ssh2';
import type { DeploymentTarget, RemoteEntryType, RemoteStat } from './deploymentTarget';

/** SFTP status code for a missing file (draft-ietf-secsh-filexfer, SSH_FX_NO_SUCH_FILE). */
const NO_SUCH_FILE = 2;

function entryType(stats: Stats): RemoteEntryType {
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
          reject(error);
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
          reject(error);
        }
      });
    });
  }
}
