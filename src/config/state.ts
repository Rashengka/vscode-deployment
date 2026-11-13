/**
 * `state.json`: the remote modification time and size recorded after each of our uploads, used
 * to detect that somebody else changed a file on the server.
 *
 * Several windows can upload at the same time, so the file is never overwritten with a copy
 * held in memory: every write re-reads the file and applies only the entries that changed.
 * A write from another process between that read and the rename can still be lost; the result
 * is a missing conflict warning, not a wrong upload.
 */
import { describeKey } from './messages';
import { STATE_VERSION, type DeploymentState, type UploadRecord } from './model';

export interface StateUpdate {
  readonly serverId: string;
  readonly remotePath: string;
  /** The new record, or `null` to forget the path. */
  readonly record: UploadRecord | null;
}

export type StateValidationResult =
  | { readonly ok: true; readonly state: DeploymentState }
  | { readonly ok: false; readonly errors: readonly string[] };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRecord(value: unknown): value is UploadRecord {
  if (!isObject(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    keys.length === 3 &&
    ['mtime', 'size', 'uploadedAt'].every(
      (key) => typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0,
    )
  );
}

export function validateState(value: unknown): StateValidationResult {
  if (!isObject(value)) {
    return { ok: false, errors: ['state: must be an object'] };
  }
  const errors: string[] = [];
  for (const key of Object.keys(value)) {
    if (key !== 'version' && key !== 'projectPath' && key !== 'servers') {
      errors.push(`state.${describeKey(key)}: unknown property`);
    }
  }
  if (value['version'] !== STATE_VERSION) {
    errors.push(`state.version: must be ${STATE_VERSION}`);
  }
  if (typeof value['projectPath'] !== 'string' || value['projectPath'] === '') {
    errors.push('state.projectPath: must be a non-empty string');
  }
  const servers = value['servers'];
  if (!isObject(servers)) {
    errors.push('state.servers: must be an object');
  } else {
    // Entries are named by position: their keys are remote paths and server ids from the file.
    Object.values(servers).forEach((paths, serverIndex) => {
      if (!isObject(paths)) {
        errors.push(`state.servers (server ${serverIndex + 1}): must be an object`);
        return;
      }
      Object.values(paths).forEach((record, pathIndex) => {
        if (!isRecord(record)) {
          errors.push(
            `state.servers (server ${serverIndex + 1}, entry ${pathIndex + 1}): must have numeric mtime, size and uploadedAt`,
          );
        }
      });
    });
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, state: value as unknown as DeploymentState };
}

/** Applies `updates` to `base` without touching any other entry. */
export function mergeState(
  base: DeploymentState,
  updates: readonly StateUpdate[],
): DeploymentState {
  // Objects without a prototype: keys come from files and remote paths, so a key such as
  // "__proto__" must stay an ordinary entry.
  const servers = dictionary<Record<string, UploadRecord>>();
  for (const [serverId, paths] of Object.entries(base.servers)) {
    servers[serverId] = Object.assign(dictionary<UploadRecord>(), paths);
  }
  for (const { serverId, remotePath, record } of updates) {
    const paths = (servers[serverId] ??= dictionary<UploadRecord>());
    if (record === null) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- keys are remote paths
      delete paths[remotePath];
      if (Object.keys(paths).length === 0) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- keys are server ids
        delete servers[serverId];
      }
    } else {
      paths[remotePath] = { ...record };
    }
  }
  return { version: STATE_VERSION, projectPath: base.projectPath, servers };
}

function dictionary<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}
