/**
 * Ownership and permission checks for the configuration folders and files.
 *
 * On POSIX systems a configuration is loaded only when every folder from the configuration root
 * down, and every file, is not a symbolic link, belongs to the current user and is not writable
 * by the group or by others. Otherwise another account could change where files are uploaded.
 *
 * On Windows, POSIX modes and owners do not apply: access is governed by the ACLs of the user
 * profile folder, which this extension does not inspect.
 */
import { lstat } from 'node:fs/promises';

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

export interface EntryStat {
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  isFile(): boolean;
  readonly uid: number;
  readonly mode: number;
  readonly nlink: number;
}

const GROUP_OR_OTHER_WRITE = 0o022;

/** Returns why `stat` is unsafe, or `null` when it is fine. */
export function entryProblem(
  stat: EntryStat,
  expected: 'directory' | 'file',
  currentUid: number,
): string | null {
  if (stat.isSymbolicLink()) {
    return 'is a symbolic link';
  }
  if (expected === 'directory' ? !stat.isDirectory() : !stat.isFile()) {
    return `is not a ${expected === 'directory' ? 'folder' : 'regular file'}`;
  }
  if (stat.uid !== currentUid) {
    return 'belongs to another user';
  }
  if ((stat.mode & GROUP_OR_OTHER_WRITE) !== 0) {
    return `is writable by other users (mode ${(stat.mode & 0o777).toString(8).padStart(3, '0')})`;
  }
  // A second hard link lets whoever owns that name change the file without touching ours.
  if (expected === 'file' && stat.nlink > 1) {
    return 'has more than one hard link';
  }
  return null;
}

/** The current user id, or `null` on platforms without POSIX owners (Windows). */
export function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

/**
 * Checks `target` when it exists. Returns a problem description, or `null` when the entry is
 * safe, missing, or the platform has no POSIX owners.
 */
export async function checkEntry(
  target: string,
  expected: 'directory' | 'file',
  uid: number | null = currentUid(),
): Promise<string | null> {
  if (uid === null) {
    return null;
  }
  let stat;
  try {
    stat = await lstat(target);
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    if (isPermissionDenied(error)) {
      return `${target} cannot be checked (permission denied)`;
    }
    throw error;
  }
  const problem = entryProblem(stat, expected, uid);
  return problem === null ? null : `${target} ${problem}`;
}

/** The `code` of a Node.js system error, or `undefined`. */
export function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

export function isNotFound(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

export function isPermissionDenied(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'EACCES' || code === 'EPERM';
}
