/**
 * Messages between the settings webview and the extension host.
 *
 * The webview is not trusted: whatever runs in it (a bug, or script injected through a server
 * name) can post any value. {@link parseWebviewMessage} therefore accepts only the message types
 * below, with exactly their properties, the expected types and bounded sizes; anything else is
 * dropped by the caller. No message in either direction carries a secret: the webview only ever
 * sees the path of an identity file, and every operation on a server (Test Connection,
 * Autodetect, the remote folder picker, Verify Mapping) asks for a passphrase in the extension
 * host.
 *
 * Text from a server (file names, paths, messages) reaches the webview only after the extension
 * host sanitized it for display, and the webview shows it as text, never as HTML. A remote
 * entry keeps its raw name too: the webview sends it back to name a folder, and the extension
 * host accepts only names it listed itself.
 *
 * Shared by both sides, so this file imports nothing that needs Node.js.
 */
import {
  INPLACE_DRAFT_KEYS,
  MAPPING_DRAFT_KEYS,
  SFTP_DRAFT_KEYS,
  type ConnectionMode,
  type InplaceDraft,
  type MappingDraft,
  type ServerDraft,
  type SftpDraft,
} from './draft';

export type PathField = 'identityFile' | 'folder';

/** Fields a picker or Autodetect can fill in (`picked`). */
export type PickedField = PathField | 'rootPath';

/** The lists whose rows are picked from the project folder. */
export type LocalList = 'mappings' | 'excludedLocalPaths';

/** What the remote folder picker chooses: the root path, a deployment path, a remote exclusion. */
export type BrowsePurpose = 'rootPath' | 'mapping' | 'excludedRemote';

/** Server operations whose progress is shown next to their button. */
export type ServerTask = 'autodetect' | 'verify';

export type RemoteKind = 'directory' | 'file' | 'symlink' | 'other';

export interface RemoteEntryView {
  /** The name as the server sent it; never shown (see `label`), only sent back in a path. */
  readonly name: string;
  /** The name sanitized for display. */
  readonly label: string;
  readonly kind: RemoteKind;
  /** Whether the name can be part of a configured path (it can be chosen or opened). */
  readonly usable: boolean;
}

export interface MappingCheckView {
  readonly localPath: string;
  readonly deploymentPath: string;
  /** Sampled files the server answered for. */
  readonly checked: number;
  readonly found: number;
  readonly verdict:
    'correct' | 'partial' | 'wrong' | 'empty' | 'excluded' | 'shadowed' | 'unchecked';
  /** The summary line, for example `18/20 files found – mapping looks correct`. */
  readonly text: string;
  /** Local paths of the files that were not found, sanitized for display. */
  readonly missing: readonly string[];
  /** Files that could not be looked up, with the server's reason; sanitized for display. */
  readonly unchecked: readonly { readonly path: string; readonly reason: string }[];
}

/** webview -> extension host */
export type WebviewMessage =
  | { readonly type: 'ready' }
  /** The current form, after every edit (the host keeps it for the unsaved-changes check). */
  | { readonly type: 'draft'; readonly servers: readonly ServerDraft[] }
  | { readonly type: 'save'; readonly servers: readonly ServerDraft[] }
  /** Discard the form and load the configuration from disk again. */
  | { readonly type: 'reload' }
  | { readonly type: 'pickPath'; readonly id: string; readonly field: PathField }
  | { readonly type: 'testConnection'; readonly server: SftpDraft }
  /** Picks a folder (mappings) or a file or folder (exclusions) inside the project. */
  | {
      readonly type: 'pickProjectPath';
      readonly id: string;
      readonly list: LocalList;
      readonly index: number;
    }
  /** Sets the root path to the home directory of the user on the server. */
  | { readonly type: 'autodetectRoot'; readonly server: SftpDraft }
  | { readonly type: 'verifyMapping'; readonly server: SftpDraft }
  /** Opens the remote folder picker: connects and lists its base folder. */
  | {
      readonly type: 'browseRemote';
      readonly server: SftpDraft;
      readonly purpose: BrowsePurpose;
      /** The row of the list the result goes to (0 for the root path). */
      readonly index: number;
    }
  /** Lists a folder of the open picker, relative to its base folder (`""` is the base). */
  | { readonly type: 'remoteList'; readonly session: string; readonly path: string }
  /** The picker was closed (OK or Cancel): its connection is closed. */
  | { readonly type: 'remoteClose' };

export interface FormError {
  /** The server the error belongs to, or `null` for the whole configuration. */
  readonly serverId: string | null;
  /** The draft field, or `null` when the error is not about one field. */
  readonly field: string | null;
  readonly message: string;
}

export type TestState = 'running' | 'connected' | 'failed';

/** extension host -> webview */
export type HostMessage =
  | {
      readonly type: 'state';
      readonly folderName: string;
      /** The servers as saved on disk. */
      readonly saved: readonly ServerDraft[];
      /** The form to show: `saved`, or unsaved edits kept by the host. */
      readonly draft: readonly ServerDraft[];
      readonly aliases: readonly string[];
      /** Why the SSH config hosts could not be listed, or `null`. */
      readonly aliasProblem: string | null;
      /** Why the configuration cannot be edited here (unsafe or invalid file), or `null`. */
      readonly problem: string | null;
      /** The configuration on disk changed since it was loaded. */
      readonly changedOnDisk: boolean;
      readonly notice: string | null;
      readonly errors: readonly FormError[];
    }
  | { readonly type: 'changedOnDisk' }
  /** A Save ended without a new state: the form stays as it is, with this message. */
  | { readonly type: 'saveFailed'; readonly message: string }
  /** A Save was written, but the new state could not be sent; the form counts as saved. */
  | { readonly type: 'saved' }
  | { readonly type: 'errors'; readonly errors: readonly FormError[] }
  | {
      readonly type: 'picked';
      readonly id: string;
      readonly field: PickedField;
      readonly path: string;
    }
  /** A path picked in the project folder for a row of a list. */
  | {
      readonly type: 'pickedItem';
      readonly id: string;
      readonly list: LocalList;
      readonly index: number;
      readonly path: string;
    }
  /** Something the user should know that is not an error of the form (shown as a warning). */
  | { readonly type: 'problem'; readonly message: string }
  | {
      readonly type: 'taskStatus';
      readonly id: string;
      readonly task: ServerTask;
      readonly state: TestState;
      readonly text: string;
    }
  | {
      readonly type: 'verifyResult';
      readonly id: string;
      /** Where the project files came from. */
      readonly source: 'git' | 'workspace';
      /** The project has more files than were sampled from. */
      readonly truncated: boolean;
      readonly checks: readonly MappingCheckView[];
    }
  /** The entries of a folder of the open picker. */
  | {
      readonly type: 'remoteListing';
      readonly session: string;
      /** The base folder of the picker on the server, sanitized for display. */
      readonly base: string;
      readonly path: string;
      readonly entries: readonly RemoteEntryView[];
      /** The folder has more entries than are shown. */
      readonly truncated: boolean;
    }
  /** The picker could not connect (`session` is `null`) or list `path`. */
  | {
      readonly type: 'remoteError';
      readonly session: string | null;
      readonly path: string;
      readonly message: string;
    }
  | {
      readonly type: 'testStatus';
      readonly id: string;
      readonly state: TestState;
      readonly text: string;
    };

/** Limits that keep a hostile message from costing much before it is refused. */
export const MAX_SERVERS = 200;
export const MAX_TEXT_LENGTH = 4096;
/** Rows of each list of a server (mappings, excluded paths). */
export const MAX_LIST_ITEMS = 500;
/** Entries of one remote folder that are listed; the rest is reported as left out. */
export const MAX_REMOTE_ENTRIES = 1000;
/** Folder levels below the base folder of the remote picker that can be opened. */
export const MAX_REMOTE_DEPTH = 16;
/** A picker session token: 128 random bits as hex. */
const SESSION = /^[0-9a-f]{32}$/;
/** Upper bound of a whole message, measured by {@link exceedsSize}. */
export const MAX_MESSAGE_SIZE = 1_000_000;
const MAX_DEPTH = 8;

/**
 * Whether `value` is larger than `limit` (text characters, property names and 8 per other
 * value), or nested deeper than any valid message. Stops as soon as the limit is passed, so a
 * huge message costs no more than the limit.
 */
export function exceedsSize(value: unknown, limit: number): boolean {
  let size = 0;
  const visit = (node: unknown, depth: number): boolean => {
    if (depth > MAX_DEPTH) {
      return true;
    }
    if (typeof node === 'string') {
      size += node.length;
    } else if (Array.isArray(node)) {
      size += 8;
      for (const item of node as readonly unknown[]) {
        if (size > limit || visit(item, depth + 1)) {
          return true;
        }
      }
    } else if (typeof node === 'object' && node !== null) {
      size += 8;
      for (const [key, item] of Object.entries(node)) {
        size += key.length;
        if (size > limit || visit(item, depth + 1)) {
          return true;
        }
      }
    } else {
      size += 8;
    }
    return size > limit;
  };
  return visit(value, 0);
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: JsonObject, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_TEXT_LENGTH;
}

function isId(value: unknown): value is string {
  return isText(value) && value !== '';
}

function isMode(value: unknown): value is ConnectionMode {
  return value === 'alias' || value === 'manual';
}

function parseMapping(value: unknown): MappingDraft | null {
  if (!isObject(value) || !hasExactKeys(value, MAPPING_DRAFT_KEYS)) {
    return null;
  }
  const { localPath, deploymentPath } = value;
  return isText(localPath) && isText(deploymentPath) ? { localPath, deploymentPath } : null;
}

function parseList<T>(value: unknown, item: (entry: unknown) => T | null): T[] | null {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    return null;
  }
  const result: T[] = [];
  for (const entry of value as readonly unknown[]) {
    const parsed = item(entry);
    if (parsed === null) {
      return null;
    }
    result.push(parsed);
  }
  return result;
}

const textItem = (entry: unknown): string | null => (isText(entry) ? entry : null);

function isIndex(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < MAX_LIST_ITEMS
  );
}

function parseSftpDraft(value: JsonObject): SftpDraft | null {
  if (!hasExactKeys(value, SFTP_DRAFT_KEYS)) {
    return null;
  }
  const {
    id,
    name,
    mode,
    sshConfigHost,
    host,
    port,
    user,
    identityFile,
    rootPath,
    keepAliveSeconds,
    idleDisconnectMinutes,
  } = value;
  const isDefault = value['default'];
  if (
    !isId(id) ||
    !isText(name) ||
    typeof isDefault !== 'boolean' ||
    !isMode(mode) ||
    !isText(sshConfigHost) ||
    !isText(host) ||
    !isText(port) ||
    !isText(user) ||
    !isText(identityFile) ||
    !isText(rootPath) ||
    !isText(keepAliveSeconds) ||
    !isText(idleDisconnectMinutes)
  ) {
    return null;
  }
  const mappings = parseList(value['mappings'], parseMapping);
  const excludedLocalPaths = parseList(value['excludedLocalPaths'], textItem);
  const excludedRemotePaths = parseList(value['excludedRemotePaths'], textItem);
  if (mappings === null || excludedLocalPaths === null || excludedRemotePaths === null) {
    return null;
  }
  return {
    id,
    type: 'sftp',
    name,
    default: isDefault,
    mode,
    sshConfigHost,
    host,
    port,
    user,
    identityFile,
    rootPath,
    keepAliveSeconds,
    idleDisconnectMinutes,
    mappings,
    excludedLocalPaths,
    excludedRemotePaths,
  };
}

function parseInplaceDraft(value: JsonObject): InplaceDraft | null {
  if (!hasExactKeys(value, INPLACE_DRAFT_KEYS)) {
    return null;
  }
  const { id, name, folder, webUrl } = value;
  const isDefault = value['default'];
  if (
    !isId(id) ||
    !isText(name) ||
    typeof isDefault !== 'boolean' ||
    !isText(folder) ||
    !isText(webUrl)
  ) {
    return null;
  }
  return { id, type: 'inplace', name, default: isDefault, folder, webUrl };
}

export function parseServerDraft(value: unknown): ServerDraft | null {
  if (!isObject(value)) {
    return null;
  }
  switch (value['type']) {
    case 'sftp':
      return parseSftpDraft(value);
    case 'inplace':
      return parseInplaceDraft(value);
    default:
      return null;
  }
}

function parseServerList(value: unknown): ServerDraft[] | null {
  if (!Array.isArray(value) || value.length > MAX_SERVERS) {
    return null;
  }
  const servers: ServerDraft[] = [];
  const ids = new Set<string>();
  for (const entry of value as readonly unknown[]) {
    const server = parseServerDraft(entry);
    if (server === null || ids.has(server.id)) {
      return null;
    }
    ids.add(server.id);
    servers.push(server);
  }
  return servers;
}

export type ParseResult =
  | { readonly ok: true; readonly message: WebviewMessage }
  /** `type` is the message type when it was a known one (for the log), else `null`. */
  | { readonly ok: false; readonly type: string | null };

const KNOWN_TYPES = new Set([
  'ready',
  'draft',
  'save',
  'reload',
  'pickPath',
  'testConnection',
  'pickProjectPath',
  'autodetectRoot',
  'verifyMapping',
  'browseRemote',
  'remoteList',
  'remoteClose',
]);

function parseSftpServer(value: unknown): SftpDraft | null {
  const server = parseServerDraft(value);
  return server?.type === 'sftp' ? server : null;
}

function isPurpose(value: unknown): value is BrowsePurpose {
  return value === 'rootPath' || value === 'mapping' || value === 'excludedRemote';
}

/** Validates a message posted by the webview. Never throws. */
export function parseWebviewMessage(value: unknown): ParseResult {
  if (!isObject(value) || typeof value['type'] !== 'string' || !KNOWN_TYPES.has(value['type'])) {
    return { ok: false, type: null };
  }
  const type = value['type'];
  const refuse: ParseResult = { ok: false, type };
  switch (type) {
    case 'ready':
    case 'reload':
    case 'remoteClose':
      return hasExactKeys(value, ['type']) ? { ok: true, message: { type } } : refuse;
    case 'draft':
    case 'save': {
      if (!hasExactKeys(value, ['type', 'servers'])) {
        return refuse;
      }
      const servers = parseServerList(value['servers']);
      return servers === null ? refuse : { ok: true, message: { type, servers } };
    }
    case 'pickPath': {
      const { id, field } = value;
      if (
        !hasExactKeys(value, ['type', 'id', 'field']) ||
        !isId(id) ||
        (field !== 'identityFile' && field !== 'folder')
      ) {
        return refuse;
      }
      return { ok: true, message: { type, id, field } };
    }
    case 'testConnection':
    case 'autodetectRoot':
    case 'verifyMapping': {
      if (!hasExactKeys(value, ['type', 'server'])) {
        return refuse;
      }
      const server = parseSftpServer(value['server']);
      return server === null ? refuse : { ok: true, message: { type, server } };
    }
    case 'pickProjectPath': {
      const { id, list, index } = value;
      if (
        !hasExactKeys(value, ['type', 'id', 'list', 'index']) ||
        !isId(id) ||
        (list !== 'mappings' && list !== 'excludedLocalPaths') ||
        !isIndex(index)
      ) {
        return refuse;
      }
      return { ok: true, message: { type, id, list, index } };
    }
    case 'browseRemote': {
      const { purpose, index } = value;
      const server = parseSftpServer(value['server']);
      if (
        !hasExactKeys(value, ['type', 'server', 'purpose', 'index']) ||
        server === null ||
        !isPurpose(purpose) ||
        !isIndex(index)
      ) {
        return refuse;
      }
      return { ok: true, message: { type, server, purpose, index } };
    }
    case 'remoteList': {
      const { session, path } = value;
      if (
        !hasExactKeys(value, ['type', 'session', 'path']) ||
        typeof session !== 'string' ||
        !SESSION.test(session) ||
        !isText(path)
      ) {
        return refuse;
      }
      return { ok: true, message: { type, session, path } };
    }
    default:
      return refuse;
  }
}
