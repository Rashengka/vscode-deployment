/**
 * The editable form of the servers in the settings panel. Shared by the extension host and the
 * webview, so it has no imports: it must build for the browser as well as for Node.js.
 *
 * Every field is what the form shows, as text where the user types it (a port of `"22x"` is a
 * draft, not a configuration). Turning a draft into a configuration, and validating it, happens
 * in the extension host only (`src/settings/save.ts`). Fields the panel does not edit (mappings,
 * excluded paths, the SSH agent setting) are not part of the draft; saving takes them over from
 * the stored server with the same id, so they survive an edit.
 */

export type ConnectionMode = 'alias' | 'manual';

export interface SftpDraft {
  readonly id: string;
  readonly type: 'sftp';
  readonly name: string;
  readonly default: boolean;
  readonly mode: ConnectionMode;
  /** The selected `Host` alias; used in `alias` mode. */
  readonly sshConfigHost: string;
  /** Used in `manual` mode only. */
  readonly host: string;
  /** Empty: from the SSH config (alias) or the default port. */
  readonly port: string;
  readonly user: string;
  /** Path to a private key file, never the key itself. */
  readonly identityFile: string;
  readonly rootPath: string;
  readonly keepAliveSeconds: string;
  readonly idleDisconnectMinutes: string;
}

export interface InplaceDraft {
  readonly id: string;
  readonly type: 'inplace';
  readonly name: string;
  readonly default: boolean;
  readonly folder: string;
  readonly webUrl: string;
}

export type ServerDraft = SftpDraft | InplaceDraft;

export type ServerType = ServerDraft['type'];

/** Keys of each draft type, exactly; messages carrying anything else are refused. */
export const SFTP_DRAFT_KEYS = [
  'id',
  'type',
  'name',
  'default',
  'mode',
  'sshConfigHost',
  'host',
  'port',
  'user',
  'identityFile',
  'rootPath',
  'keepAliveSeconds',
  'idleDisconnectMinutes',
] as const;

export const INPLACE_DRAFT_KEYS = ['id', 'type', 'name', 'default', 'folder', 'webUrl'] as const;

export type SftpTextField = Exclude<(typeof SFTP_DRAFT_KEYS)[number], 'type' | 'default' | 'mode'>;
export type InplaceTextField = Exclude<(typeof INPLACE_DRAFT_KEYS)[number], 'type' | 'default'>;

export const DEFAULT_KEEPALIVE_SECONDS = 300;
export const DEFAULT_IDLE_MINUTES = 0;

/** A name not used by any of `servers` (case-insensitively, like the validation). */
export function uniqueName(base: string, servers: readonly ServerDraft[]): string {
  const used = new Set(servers.map((server) => server.name.trim().toLowerCase()));
  if (!used.has(base.toLowerCase())) {
    return base;
  }
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!used.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
}

/** A new server of `type`; the first server of a project becomes the default. */
export function newServerDraft(
  type: ServerType,
  id: string,
  servers: readonly ServerDraft[],
): ServerDraft {
  const isDefault = servers.length === 0;
  if (type === 'inplace') {
    return {
      id,
      type,
      name: uniqueName('Local', servers),
      default: isDefault,
      folder: '',
      webUrl: '',
    };
  }
  return {
    id,
    type,
    name: uniqueName('New Server', servers),
    default: isDefault,
    mode: 'alias',
    sshConfigHost: '',
    host: '',
    port: '',
    user: '',
    identityFile: '',
    rootPath: '',
    keepAliveSeconds: String(DEFAULT_KEEPALIVE_SECONDS),
    idleDisconnectMinutes: String(DEFAULT_IDLE_MINUTES),
  };
}

/** Makes `id` the only default server, or clears the default when `value` is false. */
export function setDefault(
  servers: readonly ServerDraft[],
  id: string,
  value: boolean,
): ServerDraft[] {
  return servers.map((server) => {
    const isDefault = server.id === id ? value : value ? false : server.default;
    return server.default === isDefault ? server : { ...server, default: isDefault };
  });
}

/** Whether two lists of drafts are the same, field by field and in order. */
export function sameDrafts(a: readonly ServerDraft[], b: readonly ServerDraft[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((server, index) => {
    const other = b[index];
    if (other?.type !== server.type) {
      return false;
    }
    const keys: readonly string[] = server.type === 'sftp' ? SFTP_DRAFT_KEYS : INPLACE_DRAFT_KEYS;
    const left = server as unknown as Record<string, unknown>;
    const right = other as unknown as Record<string, unknown>;
    return keys.every((key) => left[key] === right[key]);
  });
}
