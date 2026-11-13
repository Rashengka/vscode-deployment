/**
 * Validation of `config.json` (after migration to the current version). It enforces the same
 * shape as `schemas/config.schema.json` (unknown properties are errors, so that nothing, and in
 * particular no secret, can ride along unnoticed) plus the rules a JSON schema cannot express:
 * unique names and ids, at most one default server, and safe paths.
 */
import * as path from 'node:path';
import { describeKey } from './messages';
import {
  CONFIG_VERSION,
  type DeploymentConfig,
  type InplaceServer,
  type Mapping,
  type Server,
  type SftpServer,
  type SshConnection,
} from './model';

export const CONFIG_KEYS = ['version', 'projectPath', 'servers'] as const;
export const SFTP_SERVER_KEYS = [
  'id',
  'name',
  'default',
  'type',
  'connection',
  'rootPath',
  'keepAliveSeconds',
  'idleDisconnectMinutes',
  'mappings',
  'excludedLocalPaths',
  'excludedRemotePaths',
] as const;
export const INPLACE_SERVER_KEYS = ['id', 'name', 'default', 'type', 'folder', 'webUrl'] as const;
export const CONNECTION_KEYS = ['sshConfigHost', 'host', 'port', 'user', 'identityFile'] as const;
export const MAPPING_KEYS = ['localPath', 'deploymentPath'] as const;

const MAX_KEEPALIVE_SECONDS = 86_400;
const MAX_IDLE_MINUTES = 10_080;

export type ValidationResult =
  | { readonly ok: true; readonly config: DeploymentConfig }
  | { readonly ok: false; readonly errors: readonly string[] };

export interface ValidateOptions {
  /** Platform whose rules apply to local paths (`projectPath`, in-place `folder`). */
  readonly platform: NodeJS.Platform;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

class Collector {
  readonly errors: string[] = [];

  add(where: string, message: string): void {
    this.errors.push(`${where}: ${message}`);
  }

  /** Reports properties that are not in `allowed`. */
  onlyKeys(where: string, value: JsonObject, allowed: readonly string[]): void {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) {
        this.add(`${where}.${describeKey(key)}`, 'unknown property');
      }
    }
  }

  string(where: string, value: unknown, { allowEmpty = false } = {}): string | undefined {
    if (typeof value !== 'string') {
      this.add(where, 'must be a string');
      return undefined;
    }
    if (!allowEmpty && value.trim() === '') {
      this.add(where, 'must not be empty');
      return undefined;
    }
    if (CONTROL_CHARS.test(value)) {
      this.add(where, 'must not contain control characters');
      return undefined;
    }
    return value;
  }

  nullableString(where: string, value: unknown): string | null | undefined {
    return value === null ? null : this.string(where, value);
  }

  integer(where: string, value: unknown, min: number, max: number): number | undefined {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      this.add(where, `must be a whole number from ${min} to ${max}`);
      return undefined;
    }
    return value;
  }

  boolean(where: string, value: unknown): boolean | undefined {
    if (typeof value !== 'boolean') {
      this.add(where, 'must be true or false');
      return undefined;
    }
    return value;
  }

  array(where: string, value: unknown): readonly unknown[] | undefined {
    if (!Array.isArray(value)) {
      this.add(where, 'must be an array');
      return undefined;
    }
    return value as readonly unknown[];
  }

  object(where: string, value: unknown): JsonObject | undefined {
    if (!isObject(value)) {
      this.add(where, 'must be an object');
      return undefined;
    }
    return value;
  }
}

function segments(value: string): string[] {
  return value.split('/');
}

/**
 * A path relative to a base, with forward slashes, that cannot leave the base: not absolute,
 * no `..` segment, no backslash, no control characters. `.` and an empty string mean the base.
 */
function relativeSubpath(c: Collector, where: string, value: unknown): string | undefined {
  const text = c.string(where, value, { allowEmpty: true });
  if (text === undefined) {
    return undefined;
  }
  if (text.includes('\\')) {
    c.add(where, 'must use forward slashes');
    return undefined;
  }
  if (text.startsWith('/') || /^[A-Za-z]:/.test(text)) {
    c.add(where, 'must be a relative path');
    return undefined;
  }
  if (segments(text).includes('..')) {
    c.add(where, 'must not contain ".."');
    return undefined;
  }
  return text;
}

/** An absolute POSIX path on the server, without `..` segments or backslashes. */
function absoluteRemotePath(c: Collector, where: string, value: unknown): string | undefined {
  const text = c.string(where, value);
  if (text === undefined) {
    return undefined;
  }
  if (!text.startsWith('/')) {
    c.add(where, 'must be an absolute path on the server (starting with "/")');
    return undefined;
  }
  if (text.includes('\\')) {
    c.add(where, 'must use forward slashes');
    return undefined;
  }
  if (segments(text).includes('..')) {
    c.add(where, 'must not contain ".."');
    return undefined;
  }
  return text;
}

function absoluteLocalPath(
  c: Collector,
  where: string,
  value: unknown,
  platform: NodeJS.Platform,
): string | undefined {
  const text = c.string(where, value);
  if (text === undefined) {
    return undefined;
  }
  const api = platform === 'win32' ? path.win32 : path.posix;
  if (!api.isAbsolute(text)) {
    c.add(where, 'must be an absolute path');
    return undefined;
  }
  return text;
}

function stringList(
  c: Collector,
  where: string,
  value: unknown,
  item: (c: Collector, where: string, value: unknown) => string | undefined,
): string[] {
  const list = c.array(where, value) ?? [];
  const result: string[] = [];
  list.forEach((entry, index) => {
    const text = item(c, `${where}[${index}]`, entry);
    if (text !== undefined) {
      result.push(text);
    }
  });
  return result;
}

/**
 * Refuses values that look like key material or carry line breaks, so that a private key pasted
 * into the wrong field is never stored.
 */
/**
 * Start of the base64 body of an OpenSSH private key ("openssh-key-v1" and its terminating
 * zero byte), which is what remains when the BEGIN/END lines are not copied.
 */
const OPENSSH_KEY_BODY = Buffer.from('openssh-key-v1\0').toString('base64').slice(0, 19);

function noKeyMaterial(c: Collector, where: string, value: string | null): void {
  if (
    value !== null &&
    (/-----BEGIN |PuTTY-User-Key-File/.test(value) || value.includes(OPENSSH_KEY_BODY))
  ) {
    c.add(where, 'must be a path to a key file, never the key itself');
  }
}

function validateConnection(c: Collector, where: string, value: unknown): SshConnection | null {
  const raw = c.object(where, value);
  if (raw === undefined) {
    return null;
  }
  c.onlyKeys(where, raw, CONNECTION_KEYS);
  const sshConfigHost = c.nullableString(`${where}.sshConfigHost`, raw['sshConfigHost']);
  const host = c.nullableString(`${where}.host`, raw['host']);
  const user = c.nullableString(`${where}.user`, raw['user']);
  const identityFile = c.nullableString(`${where}.identityFile`, raw['identityFile']);
  const port = raw['port'] === null ? null : c.integer(`${where}.port`, raw['port'], 1, 65_535);
  if (identityFile !== undefined) {
    noKeyMaterial(c, `${where}.identityFile`, identityFile);
  }
  if ((sshConfigHost === null) === (host === null)) {
    c.add(where, 'needs exactly one of "sshConfigHost" and "host"');
  }
  if (typeof user === 'string' && user.includes(':')) {
    // "user:password" must never be stored.
    c.add(`${where}.user`, 'must not contain ":"');
  }
  if (
    sshConfigHost === undefined ||
    host === undefined ||
    user === undefined ||
    identityFile === undefined ||
    port === undefined
  ) {
    return null;
  }
  return { sshConfigHost, host, port, user, identityFile };
}

function validateMapping(c: Collector, where: string, value: unknown): Mapping | null {
  const raw = c.object(where, value);
  if (raw === undefined) {
    return null;
  }
  c.onlyKeys(where, raw, MAPPING_KEYS);
  const localPath = relativeSubpath(c, `${where}.localPath`, raw['localPath']);
  const deploymentPath = relativeSubpath(c, `${where}.deploymentPath`, raw['deploymentPath']);
  if (localPath === undefined || deploymentPath === undefined) {
    return null;
  }
  return { localPath, deploymentPath };
}

function validateSftpServer(c: Collector, where: string, raw: JsonObject): SftpServer | null {
  c.onlyKeys(where, raw, SFTP_SERVER_KEYS);
  const connection = validateConnection(c, `${where}.connection`, raw['connection']);
  const rootPath = absoluteRemotePath(c, `${where}.rootPath`, raw['rootPath']);
  const keepAliveSeconds = c.integer(
    `${where}.keepAliveSeconds`,
    raw['keepAliveSeconds'],
    0,
    MAX_KEEPALIVE_SECONDS,
  );
  const idleDisconnectMinutes = c.integer(
    `${where}.idleDisconnectMinutes`,
    raw['idleDisconnectMinutes'],
    0,
    MAX_IDLE_MINUTES,
  );
  const mappingList = c.array(`${where}.mappings`, raw['mappings']) ?? [];
  const mappings = mappingList.map((entry, index) =>
    validateMapping(c, `${where}.mappings[${index}]`, entry),
  );
  const excludedLocalPaths = stringList(
    c,
    `${where}.excludedLocalPaths`,
    raw['excludedLocalPaths'],
    relativeSubpath,
  );
  const excludedRemotePaths = stringList(
    c,
    `${where}.excludedRemotePaths`,
    raw['excludedRemotePaths'],
    relativeSubpath,
  );
  const id = c.string(`${where}.id`, raw['id']);
  const name = c.string(`${where}.name`, raw['name']);
  const isDefault = c.boolean(`${where}.default`, raw['default']);
  if (
    id === undefined ||
    name === undefined ||
    isDefault === undefined ||
    connection === null ||
    rootPath === undefined ||
    keepAliveSeconds === undefined ||
    idleDisconnectMinutes === undefined ||
    mappings.some((mapping) => mapping === null)
  ) {
    return null;
  }
  return {
    id,
    name,
    default: isDefault,
    type: 'sftp',
    connection,
    rootPath,
    keepAliveSeconds,
    idleDisconnectMinutes,
    mappings: mappings.filter((mapping): mapping is Mapping => mapping !== null),
    excludedLocalPaths,
    excludedRemotePaths,
  };
}

function validateWebUrl(c: Collector, where: string, value: unknown): string | null | undefined {
  const text = c.nullableString(where, value);
  if (text === null || text === undefined) {
    return text;
  }
  if (!URL.canParse(text)) {
    c.add(where, 'must be a valid URL');
    return undefined;
  }
  const url = new URL(text);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    c.add(where, 'must be an http or https URL');
    return undefined;
  }
  if (url.username !== '' || url.password !== '') {
    c.add(where, 'must not contain a user name or password');
    return undefined;
  }
  return text;
}

function validateInplaceServer(
  c: Collector,
  where: string,
  raw: JsonObject,
  platform: NodeJS.Platform,
): InplaceServer | null {
  c.onlyKeys(where, raw, INPLACE_SERVER_KEYS);
  const id = c.string(`${where}.id`, raw['id']);
  const name = c.string(`${where}.name`, raw['name']);
  const isDefault = c.boolean(`${where}.default`, raw['default']);
  const folder = absoluteLocalPath(c, `${where}.folder`, raw['folder'], platform);
  const webUrl = validateWebUrl(c, `${where}.webUrl`, raw['webUrl']);
  if (
    id === undefined ||
    name === undefined ||
    isDefault === undefined ||
    folder === undefined ||
    webUrl === undefined
  ) {
    return null;
  }
  return { id, name, default: isDefault, type: 'inplace', folder, webUrl };
}

function validateServer(
  c: Collector,
  where: string,
  value: unknown,
  platform: NodeJS.Platform,
): Server | null {
  const raw = c.object(where, value);
  if (raw === undefined) {
    return null;
  }
  switch (raw['type']) {
    case 'sftp':
      return validateSftpServer(c, where, raw);
    case 'inplace':
      return validateInplaceServer(c, where, raw, platform);
    default:
      c.add(`${where}.type`, 'must be "sftp" or "inplace"');
      return null;
  }
}

function checkUnique(c: Collector, servers: readonly Server[]): void {
  const names = new Map<string, number>();
  const ids = new Map<string, number>();
  servers.forEach((server, index) => {
    // Names are compared without case, so that two entries never look the same in a list.
    const nameKey = server.name.trim().toLowerCase();
    const sameName = names.get(nameKey);
    if (sameName !== undefined) {
      c.add(`servers[${index}].name`, `is already used by servers[${sameName}]`);
    } else {
      names.set(nameKey, index);
    }
    const sameId = ids.get(server.id);
    if (sameId !== undefined) {
      c.add(`servers[${index}].id`, `is already used by servers[${sameId}]`);
    } else {
      ids.set(server.id, index);
    }
  });
  const defaults = servers.filter((server) => server.default).length;
  if (defaults > 1) {
    c.add('servers', `at most one server may be the default (found ${defaults})`);
  }
}

/** Validates a configuration that is already at `CONFIG_VERSION`. */
export function validateConfig(value: unknown, options: ValidateOptions): ValidationResult {
  const c = new Collector();
  const raw = c.object('config', value);
  if (raw === undefined) {
    return { ok: false, errors: c.errors };
  }
  c.onlyKeys('config', raw, CONFIG_KEYS);
  if (raw['version'] !== CONFIG_VERSION) {
    c.add('version', `must be ${CONFIG_VERSION}`);
  }
  const projectPath = absoluteLocalPath(c, 'projectPath', raw['projectPath'], options.platform);
  const serverList = c.array('servers', raw['servers']) ?? [];
  const servers = serverList.map((entry, index) =>
    validateServer(c, `servers[${index}]`, entry, options.platform),
  );
  const valid = servers.filter((server): server is Server => server !== null);
  checkUnique(c, valid);
  if (c.errors.length > 0 || projectPath === undefined) {
    return { ok: false, errors: c.errors };
  }
  return { ok: true, config: { version: CONFIG_VERSION, projectPath, servers: valid } };
}
