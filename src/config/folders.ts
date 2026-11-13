/**
 * Loading the configurations of all workspace folders for the context keys, the file watchers
 * and the warnings. Kept free of the VS Code API so that it can be tested on its own.
 */
import * as path from 'node:path';
import { computeContextKeys, type ContextKeyValues } from './contextKeys';
import { CONFIG_FILE_NAME } from './model';
import { loadConfig, type LoadResult, type StoreOptions } from './store';

export interface FolderRef {
  /** Stable identity of the folder (its URI). */
  readonly key: string;
  readonly name: string;
  readonly fsPath: string;
}

export interface FolderStatus {
  readonly folder: FolderRef;
  readonly result: LoadResult;
}

export interface FoldersSnapshot {
  readonly statuses: readonly FolderStatus[];
  readonly keys: ContextKeyValues;
  /** Folders where a configuration exists or would be created; they are watched for changes. */
  readonly configDirs: readonly string[];
}

export type ConfigLoader = (folder: string, options: StoreOptions) => Promise<LoadResult>;

/**
 * Loads every folder. A folder that fails unexpectedly counts as invalid (and so as having no
 * upload target) instead of stopping the others.
 */
export async function loadFolders(
  folders: readonly FolderRef[],
  options: StoreOptions,
  load: ConfigLoader = loadConfig,
): Promise<FoldersSnapshot> {
  const statuses: FolderStatus[] = [];
  for (const folder of folders) {
    let result: LoadResult;
    try {
      result = await load(folder.fsPath, options);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      result = { status: 'invalid', dir: null, errors: [`could not be loaded: ${detail}`] };
    }
    statuses.push({ folder, result });
  }
  const configDirs = new Set<string>();
  for (const { result } of statuses) {
    if (result.status !== 'unsafe' && result.dir !== null) {
      configDirs.add(result.dir);
    }
  }
  return {
    statuses,
    keys: computeContextKeys(statuses.map((status) => status.result)),
    configDirs: [...configDirs],
  };
}

/** The warning to show for a folder, or `null` when its configuration is fine or missing. */
export function describeProblem(status: FolderStatus): string | null {
  const { folder, result } = status;
  switch (result.status) {
    case 'unsafe':
      return `Deployment configuration of "${folder.name}" was not loaded: ${result.problem}.`;
    case 'invalid': {
      const [first, ...rest] = result.errors;
      const more = rest.length > 0 ? ` (and ${rest.length} more)` : '';
      return `Deployment configuration of "${folder.name}" is not valid: ${first ?? 'unknown error'}${more}.`;
    }
    default:
      return null;
  }
}

/** Shows each message once per key until it changes or the problem goes away. */
export class NotificationDeduplicator {
  private readonly shown = new Map<string, string>();

  /** Returns whether `message` should be shown now for `key`; `null` clears the key. */
  shouldShow(key: string, message: string | null): boolean {
    if (message === null) {
      this.shown.delete(key);
      return false;
    }
    if (this.shown.get(key) === message) {
      return false;
    }
    this.shown.set(key, message);
    return true;
  }
}

export interface WatchSpec {
  readonly base: string;
  readonly pattern: string;
}

const GLOB_SPECIAL = /[*?[\]{},!]/;

/**
 * What to watch so that `config.json` in `dir` is noticed even when `dir` (or its parent) does
 * not exist yet: the nearest existing folder among `dir`, its parent and its grandparent, with a
 * pattern down to the file. Returns `null` when none exists, or when the folder name would have
 * to be written into the pattern but contains glob characters.
 */
export function watchSpec(dir: string, exists: (folder: string) => boolean): WatchSpec | null {
  if (exists(dir)) {
    return { base: dir, pattern: CONFIG_FILE_NAME };
  }
  const name = path.basename(dir);
  const parent = path.dirname(dir);
  if (GLOB_SPECIAL.test(name)) {
    return null;
  }
  if (exists(parent)) {
    return { base: parent, pattern: `${name}/${CONFIG_FILE_NAME}` };
  }
  const grandparent = path.dirname(parent);
  if (exists(grandparent) && !GLOB_SPECIAL.test(path.basename(parent))) {
    return { base: grandparent, pattern: `${path.basename(parent)}/${name}/${CONFIG_FILE_NAME}` };
  }
  return null;
}
