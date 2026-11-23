/**
 * Reading the deployed version of a file for Compare with Deployed Version, without the VS Code
 * API. Everything about the file comes from the server and is untrusted: its type is checked
 * with `lstat` (a symbolic link is refused, not followed), and its size is limited while it is
 * read, not by what the server reports.
 */
import {
  RemoteFileTooLargeError,
  type DeploymentTarget,
  type RemoteEntryType,
  type RemoteStat,
} from '../transport/deploymentTarget';

/** SFTP status code SSH_FX_NO_SUCH_FILE. */
const NO_SUCH_FILE = 2;

/** Largest file compared (20 MB). */
export const MAX_COMPARE_BYTES = 20 * 1024 * 1024;

/** How much of a file is looked at to tell binary from text. */
export const BINARY_SNIFF_BYTES = 8192;

export type DeployedVersion =
  | { readonly kind: 'text'; readonly content: Buffer; readonly stat: RemoteStat }
  | { readonly kind: 'missing' }
  | { readonly kind: 'symlink' }
  | { readonly kind: 'notFile'; readonly type: Exclude<RemoteEntryType, 'file' | 'symlink'> }
  | { readonly kind: 'tooLarge'; readonly maxBytes: number }
  | { readonly kind: 'binary'; readonly size: number };

/** Whether `data` looks binary: it has a NUL byte in its first {@link BINARY_SNIFF_BYTES}. */
export function looksBinary(data: Uint8Array): boolean {
  return data.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/**
 * The deployed version of `remotePath`. Errors other than "too large" and "no such file" (a
 * refused read, a closed connection) are passed on.
 */
export async function fetchDeployedVersion(
  target: Pick<DeploymentTarget, 'lstat' | 'readFile'>,
  remotePath: string,
  maxBytes = MAX_COMPARE_BYTES,
  signal?: AbortSignal,
): Promise<DeployedVersion> {
  const stat = await target.lstat(remotePath);
  if (stat === null) {
    return { kind: 'missing' };
  }
  if (stat.type === 'symlink') {
    return { kind: 'symlink' };
  }
  if (stat.type !== 'file') {
    return { kind: 'notFile', type: stat.type };
  }
  let content: Buffer;
  try {
    content = await target.readFile(remotePath, maxBytes, signal);
  } catch (error) {
    if (error instanceof RemoteFileTooLargeError) {
      return { kind: 'tooLarge', maxBytes: error.maxBytes };
    }
    // Deleted on the server between lstat and the read.
    if ((error as Error & { code?: unknown }).code === NO_SUCH_FILE) {
      return { kind: 'missing' };
    }
    throw error;
  }
  if (looksBinary(content)) {
    return { kind: 'binary', size: content.length };
  }
  return { kind: 'text', content, stat };
}
