/**
 * Messages between the settings webview and the extension host.
 *
 * The webview is not trusted: whatever runs in it (a bug, or script injected through a server
 * name) can post any value. {@link parseWebviewMessage} therefore accepts only the message types
 * below, with exactly their properties, the expected types and bounded sizes; anything else is
 * dropped by the caller. No message in either direction carries a secret: the webview only ever
 * sees the path of an identity file, and Test Connection asks for a passphrase in the extension
 * host.
 *
 * Shared by both sides, so this file imports nothing that needs Node.js.
 */
import {
  INPLACE_DRAFT_KEYS,
  SFTP_DRAFT_KEYS,
  type ConnectionMode,
  type InplaceDraft,
  type ServerDraft,
  type SftpDraft,
} from './draft';

export type PathField = 'identityFile' | 'folder';

/** webview -> extension host */
export type WebviewMessage =
  | { readonly type: 'ready' }
  /** The current form, after every edit (the host keeps it for the unsaved-changes check). */
  | { readonly type: 'draft'; readonly servers: readonly ServerDraft[] }
  | { readonly type: 'save'; readonly servers: readonly ServerDraft[] }
  /** Discard the form and load the configuration from disk again. */
  | { readonly type: 'reload' }
  | { readonly type: 'pickPath'; readonly id: string; readonly field: PathField }
  | { readonly type: 'testConnection'; readonly server: SftpDraft };

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
      readonly field: PathField;
      readonly path: string;
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

const KNOWN_TYPES = new Set(['ready', 'draft', 'save', 'reload', 'pickPath', 'testConnection']);

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
    case 'testConnection': {
      if (!hasExactKeys(value, ['type', 'server'])) {
        return refuse;
      }
      const server = parseServerDraft(value['server']);
      return server?.type === 'sftp' ? { ok: true, message: { type, server } } : refuse;
    }
    default:
      return refuse;
  }
}
