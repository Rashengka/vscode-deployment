/**
 * Turns the connection settings of a server into what is needed to connect: host, port, user,
 * identity files, agent and known_hosts files, following the user's ssh configuration the way
 * `ssh` would, and records which configuration files were read (they are watched while
 * connected).
 */
import { posix, win32 } from 'node:path';
import type { SshConnection } from '../config/model';
import { resolveSshHost, type ResolvedSshHost, type SshConfigEnvironment } from './sshConfig';

/** The machine-specific inputs; tests pass a temporary home directory. */
export interface SshEnvironment {
  readonly homeDirectory: string;
  readonly localUser: string;
  readonly platform?: 'posix' | 'win32';
  readonly programDataDirectory?: string;
  /** Defaults to `<home>/.ssh/config`. */
  readonly userConfigPath?: string;
  /** Defaults to the platform's system file; `null` disables it. */
  readonly systemConfigPath?: string | null;
  /** The value of `SSH_AUTH_SOCK`, if any. */
  readonly agentSocket: string | undefined;
  /** `vscode.env.remoteName`; connections are refused when it is set. */
  readonly remoteName: string | undefined;
  /** See {@link SshConfigEnvironment.readFile}. */
  readFile(path: string): Promise<string | undefined>;
  listDirectory(path: string): Promise<readonly string[] | undefined>;
}

export interface ConnectionTarget {
  readonly resolved: ResolvedSshHost;
  /** Alias for messages and the `ssh` advice; `undefined` for a manual connection. */
  readonly alias: string | undefined;
  /** Every ssh configuration file that was read or looked for. */
  readonly configFiles: readonly string[];
  /** All known_hosts files, user files first. */
  readonly knownHostsFiles: readonly string[];
  /** `user@host:port`, for messages. */
  readonly description: string;
}

export class ConnectionSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionSettingsError';
  }
}

function expandHome(path: string, env: SshEnvironment): string {
  const api =
    (env.platform ?? (process.platform === 'win32' ? 'win32' : 'posix')) === 'win32'
      ? win32
      : posix;
  let expanded = path;
  if (path === '~') {
    expanded = env.homeDirectory;
  } else if (path.startsWith('~/') || (api === win32 && path.startsWith('~\\'))) {
    expanded = api.join(env.homeDirectory, path.slice(2));
  }
  if (!api.isAbsolute(expanded)) {
    throw new ConnectionSettingsError(
      `identityFile "${path}" must be an absolute path or start with ~/.`,
    );
  }
  return api.normalize(expanded);
}

/**
 * Resolves `connection` like `ssh [-p port] [-i identityFile] [user@]host` would: the ssh
 * configuration applies to the alias (or to the manual host name) and the explicit values of
 * the server override it. An explicit identity file is tried before the configured ones.
 */
export async function resolveConnectionTarget(
  connection: SshConnection,
  env: SshEnvironment,
  beforeRead: (path: string) => void = () => undefined,
): Promise<ConnectionTarget> {
  const configFiles: string[] = [];
  const configEnv: SshConfigEnvironment = {
    homeDirectory: env.homeDirectory,
    localUser: env.localUser,
    ...(env.platform === undefined ? {} : { platform: env.platform }),
    ...(env.programDataDirectory === undefined
      ? {}
      : { programDataDirectory: env.programDataDirectory }),
    ...(env.userConfigPath === undefined ? {} : { userConfigPath: env.userConfigPath }),
    ...(env.systemConfigPath === undefined ? {} : { systemConfigPath: env.systemConfigPath }),
    readFile: (path) => {
      configFiles.push(path);
      beforeRead(path);
      return env.readFile(path);
    },
    listDirectory: (path) => env.listDirectory(path),
  };
  const alias = connection.sshConfigHost ?? undefined;
  const name = connection.sshConfigHost ?? connection.host;
  if (name === null) {
    throw new ConnectionSettingsError('The server has neither an ssh config host nor a host.');
  }
  const base = await resolveSshHost(name, configEnv);

  const port = connection.port ?? base.port;
  const user = connection.user ?? base.user;
  const identityFiles =
    connection.identityFile === null
      ? base.identityFiles
      : [
          expandHome(connection.identityFile, env),
          // With an explicit key, OpenSSH's default keys are not tried.
          ...(base.identityFilesAreDefaults ? [] : base.identityFiles),
        ].filter((file, index, all) => all.indexOf(file) === index);
  const lowerHost = base.hostName.toLowerCase();
  const knownHostsName = base.hostKeyAlias ?? (port === 22 ? lowerHost : `[${lowerHost}]:${port}`);
  const resolved: ResolvedSshHost = {
    ...base,
    port,
    user,
    identityFiles,
    identityFilesAreDefaults: connection.identityFile === null && base.identityFilesAreDefaults,
    knownHostsName,
  };
  return {
    resolved,
    alias,
    configFiles,
    knownHostsFiles: [...resolved.userKnownHostsFiles, ...resolved.globalKnownHostsFiles],
    description: `${user}@${base.hostName}:${port}`,
  };
}

/**
 * The agent socket to use when the server allows the agent, or `undefined` for none:
 * `IdentityAgent` from the ssh configuration, otherwise `SSH_AUTH_SOCK`, otherwise (on Windows)
 * the OpenSSH agent's named pipe.
 */
export function agentSocketFor(
  resolved: ResolvedSshHost,
  env: Pick<SshEnvironment, 'agentSocket' | 'platform'>,
): string | undefined {
  const configured = resolved.identityAgent;
  if (configured === 'none') {
    return undefined;
  }
  if (configured !== undefined && configured !== 'SSH_AUTH_SOCK') {
    return configured;
  }
  if (env.agentSocket !== undefined && env.agentSocket !== '') {
    return env.agentSocket;
  }
  const windows = (env.platform ?? (process.platform === 'win32' ? 'win32' : 'posix')) === 'win32';
  return windows ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined;
}
