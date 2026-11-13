/**
 * Data model of the per-project configuration (`config.json`) and the upload history
 * (`state.json`). Both files live outside the project repository and never contain secrets:
 * the model has no field for a password, a passphrase or key content.
 */

/** The `config.json` version written by this build. Older versions are migrated on load. */
export const CONFIG_VERSION = 1;

/** The `state.json` version written by this build. */
export const STATE_VERSION = 1;

export const CONFIG_FILE_NAME = 'config.json';
export const STATE_FILE_NAME = 'state.json';

export interface SshConnection {
  /** A `Host` alias from the user's SSH config; `null` for a manual connection. */
  readonly sshConfigHost: string | null;
  readonly host: string | null;
  readonly port: number | null;
  readonly user: string | null;
  /** Path to a private key file. Never the key itself. */
  readonly identityFile: string | null;
}

export interface Mapping {
  /** Relative to the project folder, with forward slashes; `.` is the project root. */
  readonly localPath: string;
  /** Relative to the server's `rootPath`, with forward slashes. */
  readonly deploymentPath: string;
}

interface ServerBase {
  readonly id: string;
  readonly name: string;
  readonly default: boolean;
}

export interface SftpServer extends ServerBase {
  readonly type: 'sftp';
  readonly connection: SshConnection;
  /** Absolute POSIX path on the server. */
  readonly rootPath: string;
  readonly keepAliveSeconds: number;
  /** `0` keeps the connection until the window closes. */
  readonly idleDisconnectMinutes: number;
  readonly mappings: readonly Mapping[];
  readonly excludedLocalPaths: readonly string[];
  readonly excludedRemotePaths: readonly string[];
}

/**
 * A server that runs directly from the project folder (for example a local web server). Nothing
 * is copied to it; it only records where the sources are and where the site runs.
 */
export interface InplaceServer extends ServerBase {
  readonly type: 'inplace';
  /** Absolute local path of the folder the server runs from. */
  readonly folder: string;
  /** Where the site is served, or `null`. */
  readonly webUrl: string | null;
}

export type Server = SftpServer | InplaceServer;

export interface DeploymentConfig {
  readonly version: typeof CONFIG_VERSION;
  /** Canonical absolute path of the project folder this file belongs to. */
  readonly projectPath: string;
  readonly servers: readonly Server[];
}

export interface UploadRecord {
  /** Remote modification time (seconds since the epoch) right after our upload. */
  readonly mtime: number;
  readonly size: number;
  /** When the upload finished (milliseconds since the epoch). */
  readonly uploadedAt: number;
}

export interface DeploymentState {
  readonly version: typeof STATE_VERSION;
  /** The project folder this history belongs to, as in `config.json`. */
  readonly projectPath: string;
  /** Server id -> remote path -> last upload. */
  readonly servers: Readonly<Record<string, Readonly<Record<string, UploadRecord>>>>;
}

export function emptyConfig(projectPath: string): DeploymentConfig {
  return { version: CONFIG_VERSION, projectPath, servers: [] };
}

export function emptyState(projectPath: string): DeploymentState {
  return { version: STATE_VERSION, projectPath, servers: {} };
}
