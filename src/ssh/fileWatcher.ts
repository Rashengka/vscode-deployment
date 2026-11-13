/**
 * Watches the files a connection was configured from (config.json, ssh configuration files,
 * known_hosts), so that the connection can be closed when one of them changes outside the
 * extension.
 *
 * Each file is watched through its directory, because editors and tools usually replace a file
 * by renaming a new one over it, which a watch on the old file would not see. A file that does
 * not exist yet is watched through its nearest existing ancestor, since creating it also
 * changes the configuration.
 *
 * Directory events are only a hint: some platforms report changes made shortly before the
 * watch started, and unrelated events in the same directory. A file counts as changed when its
 * signature (existence, inode, size, modification and change times of the path and of the
 * file it points to) differs from the baseline: the signature taken before the file was read,
 * or else when the watch started. A file reached through a symbolic link is also watched in
 * the directory of its target.
 */
import { existsSync, lstatSync, realpathSync, statSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';

export interface Disposable {
  dispose(): void;
}

export interface FileWatcher {
  /** The current signature of `file`, for a baseline taken before reading it. */
  signature(file: string): string;
  /**
   * Calls `onChange` with the watched path when one of `files` changed compared with
   * `baseline` (or, for files without a baseline, with the state when the watch started).
   * A difference that already exists when the watch starts is reported right away.
   */
  watch(
    files: readonly string[],
    onChange: (file: string) => void,
    baseline?: ReadonlyMap<string, string>,
  ): Disposable;
}

/** The directory to watch for `file` and the entry name in it that leads to `file`. */
export function watchTarget(
  file: string,
  exists: (path: string) => boolean,
): { directory: string; entry: string } {
  let entry = basename(file);
  let directory = dirname(file);
  while (!exists(directory) && dirname(directory) !== directory) {
    entry = basename(directory);
    directory = dirname(directory);
  }
  return { directory, entry };
}

/**
 * What identifies the current version of a file: `missing` when it does not exist, the error
 * code when it cannot be examined (which then differs from any readable state).
 */
export function fileSignature(file: string): string {
  const describe = (stat: typeof statSync): string => {
    let stats;
    try {
      stats = stat(file, { throwIfNoEntry: false, bigint: true });
    } catch (error) {
      return `unreadable:${(error as NodeJS.ErrnoException).code ?? 'unknown'}`;
    }
    if (stats === undefined) {
      return 'missing';
    }
    return [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs, stats.mode].join(':');
  };
  // The link itself (retargeting it) and the file it points to (editing that file).
  return `${describe(lstatSync)}|${describe(statSync)}`;
}

/** The real path of `file` when it differs (a symbolic link somewhere on the way). */
function linkTarget(file: string): string | undefined {
  let real: string;
  try {
    real = realpathSync(file);
  } catch {
    // Missing or unreadable: there is no target to watch; the signature covers the path.
    return undefined;
  }
  return real === file ? undefined : real;
}

/** {@link FileWatcher} based on `fs.watch`. Throws when a directory cannot be watched. */
export const nodeFileWatcher: FileWatcher = {
  signature: fileSignature,
  watch(files, onChange, baseline) {
    const watchers: FSWatcher[] = [];
    const dispose = (): void => {
      for (const watcher of watchers.splice(0)) {
        watcher.close();
      }
    };
    const unique = [...new Set(files)];
    const signatures = new Map(
      unique.map((file) => [file, baseline?.get(file) ?? fileSignature(file)]),
    );
    let disposed = false;
    const check = (file: string): void => {
      const current = fileSignature(file);
      if (!disposed && current !== signatures.get(file)) {
        signatures.set(file, current);
        onChange(file);
      }
    };
    try {
      for (const file of unique) {
        const paths = [file];
        const real = linkTarget(file);
        if (real !== undefined) {
          paths.push(real);
        }
        for (const path of paths) {
          const { directory, entry } = watchTarget(path, existsSync);
          const watcher = watch(directory, { persistent: false }, (_event, name) => {
            // Without a name the platform could not say what changed, so check the file.
            if (name === null || name === entry) {
              check(file);
            }
          });
          // A watch that stops working can no longer report changes: treat it as one.
          watcher.on('error', () => {
            if (!disposed) {
              onChange(file);
            }
          });
          watchers.push(watcher);
        }
      }
    } catch (error) {
      dispose();
      throw error;
    }
    // Changes between the baseline and now; reported after this call has returned.
    void Promise.resolve().then(() => {
      for (const file of unique) {
        check(file);
      }
    });
    return {
      dispose: () => {
        disposed = true;
        dispose();
      },
    };
  },
};
