/**
 * Turning the drafts of the settings panel into a configuration and back. Runs in the extension
 * host only: the configuration is checked by the same validation as `config.json` when it is
 * loaded (`validateConfig`), so the panel can never save a file that would not load again.
 *
 * Validation messages are rewritten for the form: they name the field as the form labels it and
 * refer to other servers by name, never by their position in the file. Like the messages of the
 * validation itself they never repeat a value that was typed.
 */
import type { DeploymentConfig, InplaceServer, Server, SftpServer } from '../config/model';
import { validateConfig, type ValidateOptions } from '../config/validate';
import type { InplaceDraft, ServerDraft, SftpDraft } from './draft';
import type { FormError } from './protocol';

export function draftFromServer(server: Server): ServerDraft {
  if (server.type === 'inplace') {
    return {
      id: server.id,
      type: 'inplace',
      name: server.name,
      default: server.default,
      folder: server.folder,
      webUrl: server.webUrl ?? '',
    };
  }
  const { connection } = server;
  return {
    id: server.id,
    type: 'sftp',
    name: server.name,
    default: server.default,
    mode: connection.sshConfigHost === null ? 'manual' : 'alias',
    sshConfigHost: connection.sshConfigHost ?? '',
    host: connection.host ?? '',
    port: connection.port === null ? '' : String(connection.port),
    user: connection.user ?? '',
    identityFile: connection.identityFile ?? '',
    rootPath: server.rootPath,
    keepAliveSeconds: String(server.keepAliveSeconds),
    idleDisconnectMinutes: String(server.idleDisconnectMinutes),
    mappings: server.mappings.map(({ localPath, deploymentPath }) => ({
      localPath,
      deploymentPath,
    })),
    excludedLocalPaths: [...server.excludedLocalPaths],
    excludedRemotePaths: [...server.excludedRemotePaths],
  };
}

export function draftsFromConfig(config: DeploymentConfig | null): ServerDraft[] {
  return config === null ? [] : config.servers.map(draftFromServer);
}

function optional(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

/** A whole number typed into the form; anything else becomes NaN, which validation refuses. */
function wholeNumber(text: string): number {
  const trimmed = text.trim();
  return /^\d{1,9}$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

function sftpFromDraft(draft: SftpDraft, stored: Server | undefined): SftpServer {
  const previous = stored?.type === 'sftp' ? stored : undefined;
  const alias = draft.mode === 'alias';
  return {
    id: draft.id,
    name: draft.name.trim(),
    default: draft.default,
    type: 'sftp',
    connection: {
      sshConfigHost: alias ? optional(draft.sshConfigHost) : null,
      // An empty host stays a string, so that validation reports it on the host field.
      host: alias ? null : draft.host.trim(),
      port: optional(draft.port) === null ? null : wholeNumber(draft.port),
      user: optional(draft.user),
      identityFile: optional(draft.identityFile),
      useSshAgent: previous?.connection.useSshAgent ?? false,
    },
    rootPath: draft.rootPath.trim(),
    keepAliveSeconds: wholeNumber(draft.keepAliveSeconds),
    idleDisconnectMinutes: wholeNumber(draft.idleDisconnectMinutes),
    mappings: draft.mappings.map((mapping) => ({
      localPath: mapping.localPath.trim(),
      deploymentPath: mapping.deploymentPath.trim(),
    })),
    excludedLocalPaths: draft.excludedLocalPaths.map((entry) => entry.trim()),
    excludedRemotePaths: draft.excludedRemotePaths.map((entry) => entry.trim()),
  };
}

function inplaceFromDraft(draft: InplaceDraft): InplaceServer {
  return {
    id: draft.id,
    name: draft.name.trim(),
    default: draft.default,
    type: 'inplace',
    folder: draft.folder.trim(),
    webUrl: optional(draft.webUrl),
  };
}

function serverFromDraft(draft: ServerDraft, stored: readonly Server[]): Server {
  const previous = stored.find((server) => server.id === draft.id);
  return draft.type === 'sftp' ? sftpFromDraft(draft, previous) : inplaceFromDraft(draft);
}

const FIELD_LABELS: Readonly<Record<string, string>> = {
  name: 'Name',
  default: 'Default',
  sshConfigHost: 'SSH config host',
  host: 'Host',
  port: 'Port',
  user: 'User',
  identityFile: 'Identity file',
  rootPath: 'Root path',
  keepAliveSeconds: 'Keep-alive interval',
  idleDisconnectMinutes: 'Idle disconnect',
  folder: 'Folder',
  webUrl: 'Web URL',
};

/** Property path below a server -> draft field. */
const FIELD_PATHS: Readonly<Record<string, string>> = {
  name: 'name',
  default: 'default',
  'connection.sshConfigHost': 'sshConfigHost',
  'connection.host': 'host',
  'connection.port': 'port',
  'connection.user': 'user',
  'connection.identityFile': 'identityFile',
  rootPath: 'rootPath',
  keepAliveSeconds: 'keepAliveSeconds',
  idleDisconnectMinutes: 'idleDisconnectMinutes',
  folder: 'folder',
  webUrl: 'webUrl',
};

const MAPPING_FIELD = /^mappings\[(\d+)\]\.(localPath|deploymentPath)$/;
const EXCLUDED_FIELD = /^(excludedLocalPaths|excludedRemotePaths)\[(\d+)\]$/;

/** The draft field and its label for a property path inside one of the lists. */
function listField(where: string): { field: string; label: string } | undefined {
  const mapping = MAPPING_FIELD.exec(where);
  if (mapping !== null) {
    const [, index = '0', key = ''] = mapping;
    const which = key === 'localPath' ? 'local path' : 'deployment path';
    return { field: `mappings.${index}.${key}`, label: `Mapping ${Number(index) + 1}, ${which}` };
  }
  const excluded = EXCLUDED_FIELD.exec(where);
  if (excluded !== null) {
    const [, list = '', index = '0'] = excluded;
    const which = list === 'excludedLocalPaths' ? 'local' : 'remote';
    return { field: `${list}.${index}`, label: `Excluded ${which} path ${Number(index) + 1}` };
  }
  return undefined;
}

const SERVER_ERROR = /^servers\[(\d+)\]\.?([^:]*): (.*)$/;
const SERVER_REFERENCE = /servers\[(\d+)\]/g;

/** Rewrites one message of `validateConfig` for the form. */
function formError(error: string, drafts: readonly ServerDraft[]): FormError {
  const nameOf = (index: string): string => {
    const name = drafts[Number(index)]?.name.trim();
    return name === undefined || name === '' ? 'another server' : `"${name}"`;
  };
  const match = SERVER_ERROR.exec(error);
  if (match === null) {
    const message = error
      .replace(/^(servers|config): /, '')
      .replace(SERVER_REFERENCE, (_all, n) => nameOf(String(n)));
    return { serverId: null, field: null, message };
  }
  const [, index = '', where = '', rest = ''] = match;
  const draft = drafts[Number(index)];
  const message = rest.replace(SERVER_REFERENCE, (_all, n) => nameOf(String(n)));
  if (where === 'connection' && draft?.type === 'sftp') {
    // "needs exactly one of sshConfigHost and host": only an empty alias leads here.
    return draft.mode === 'alias'
      ? { serverId: draft.id, field: 'sshConfigHost', message: 'Choose an SSH config host.' }
      : { serverId: draft.id, field: 'host', message: 'Host: must not be empty' };
  }
  const inList = listField(where);
  if (inList !== undefined) {
    return {
      serverId: draft?.id ?? null,
      field: inList.field,
      message: `${inList.label}: ${message}`,
    };
  }
  const field = FIELD_PATHS[where];
  if (field === undefined) {
    return { serverId: draft?.id ?? null, field: null, message: `${where}: ${message}` };
  }
  return {
    serverId: draft?.id ?? null,
    field,
    message: `${FIELD_LABELS[field] ?? field}: ${message}`,
  };
}

export type BuildResult =
  | { readonly ok: true; readonly config: DeploymentConfig }
  | { readonly ok: false; readonly errors: readonly FormError[] };

/**
 * The configuration for `drafts`, validated. `stored` are the servers as loaded, from which
 * fields the form does not edit are taken over by server id.
 */
export function buildConfig(
  projectPath: string,
  drafts: readonly ServerDraft[],
  stored: readonly Server[],
  options: ValidateOptions,
): BuildResult {
  const config: DeploymentConfig = {
    version: 1,
    projectPath,
    servers: drafts.map((draft) => serverFromDraft(draft, stored)),
  };
  const validated = validateConfig(config, options);
  if (validated.ok) {
    return { ok: true, config: validated.config };
  }
  return { ok: false, errors: validated.errors.map((error) => formError(error, drafts)) };
}

export type SftpServerResult =
  | { readonly ok: true; readonly server: SftpServer }
  | { readonly ok: false; readonly errors: readonly FormError[] };

/** The server of one draft, validated on its own (for Test Connection before saving). */
export function sftpServerFromDraft(
  projectPath: string,
  draft: SftpDraft,
  stored: readonly Server[],
  options: ValidateOptions,
): SftpServerResult {
  const result = buildConfig(projectPath, [draft], stored, options);
  if (!result.ok) {
    return result;
  }
  const [server] = result.config.servers;
  if (server?.type !== 'sftp') {
    throw new Error('A validated SFTP draft did not give an SFTP server.');
  }
  return { ok: true, server };
}
