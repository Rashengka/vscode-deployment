/**
 * File access for the ssh configuration resolver on the real file system.
 *
 * `readFile` returns `undefined` only when the file does not exist. Anything else that is not
 * a readable regular file of at most {@link MAX_CONFIG_FILE_BYTES} bytes is an error, so that
 * a configuration that cannot be read is never treated as an empty one.
 */
import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { MAX_CONFIG_FILE_BYTES, SshConfigError, type SshConfigEnvironment } from './sshConfig';

function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Reads a regular file of at most `maxBytes`; `undefined` when it does not exist. */
export async function readRegularFile(
  path: string,
  maxBytes: number = MAX_CONFIG_FILE_BYTES,
): Promise<string | undefined> {
  let handle;
  try {
    // O_NONBLOCK keeps a FIFO from blocking the open (it is rejected right after); Windows
    // has no such flag.
    handle = await open(
      path,
      constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK),
    );
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new SshConfigError('Not a regular file', undefined, path, undefined);
    }
    if (stats.size > maxBytes) {
      throw new SshConfigError(`File is larger than ${maxBytes} bytes`, undefined, path, undefined);
    }
    // Read one byte more than allowed to notice a file that grew after stat.
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) {
        break;
      }
      length += bytesRead;
      if (length > maxBytes) {
        throw new SshConfigError(
          `File is larger than ${maxBytes} bytes`,
          undefined,
          path,
          undefined,
        );
      }
    }
    return buffer.toString('utf8', 0, length);
  } finally {
    await handle.close();
  }
}

/** Lists a directory; `undefined` when it does not exist or is not a directory. */
export async function listDirectory(path: string): Promise<readonly string[] | undefined> {
  try {
    return await readdir(path);
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

/** The file access part of {@link SshConfigEnvironment} backed by the real file system. */
export const nodeFileAccess: Pick<SshConfigEnvironment, 'readFile' | 'listDirectory'> = {
  readFile: (path) => readRegularFile(path),
  listDirectory,
};
