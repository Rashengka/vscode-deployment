/**
 * Writes a file so that readers see either the old or the new content, never a partial one:
 * the data goes to a new temporary file in the same folder (created exclusively, mode 0600),
 * is flushed to disk and then renamed over the target.
 */
import { randomBytes } from 'node:crypto';
import { link, open, rename, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import { FILE_MODE, isNotFound } from './fileSafety';

export async function writeFileAtomic(target: string, data: string): Promise<void> {
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`,
  );
  // 'wx' fails if the name exists, so a planted file or symbolic link is never followed.
  const handle = await open(temp, 'wx', FILE_MODE);
  let renamed = false;
  try {
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, target);
    renamed = true;
  } finally {
    if (!renamed) {
      await removeIfPresent(temp);
    }
  }
  await syncDirectory(path.dirname(target));
}

/**
 * Creates `target` with `data` only if it does not exist yet; returns `false` when it already
 * exists (for example because another window created it first). Readers never see a partial
 * file: the content is written to a temporary file that is then hard-linked to the target name,
 * which fails instead of replacing an existing file.
 */
export async function createFileExclusive(target: string, data: string): Promise<boolean> {
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`,
  );
  const handle = await open(temp, 'wx', FILE_MODE);
  try {
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temp, target);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        return false;
      }
      throw error;
    }
  } finally {
    await removeIfPresent(temp);
  }
  await syncDirectory(path.dirname(target));
  return true;
}

async function removeIfPresent(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
}

/** Makes the rename durable on POSIX; Windows cannot open folders for flushing. */
async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') {
    return;
  }
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
