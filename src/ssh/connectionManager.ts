/**
 * Holds at most one SSH connection per server, runs operations on it one after another and
 * closes it when it is idle, when asked to, or when its configuration changes on disk.
 *
 * Security rules this class implements:
 * - A connection exists only in memory. Nothing about it (and never a passphrase or key) is
 *   stored. After any disconnect the next operation connects again and asks for the
 *   passphrase again; there is no automatic reconnect.
 * - Host keys are checked strictly against known_hosts (see `hostKeyPolicy.ts`).
 * - Only the algorithms of `algorithms.ts` are offered. ssh2's `debug` option is never set and
 *   host keys announced by the server after login are ignored.
 * - Remote windows are refused (see `remoteWindow.ts`).
 * - Each operation gets a frozen copy of the server configuration taken when it starts.
 *
 * `vscode` is not used here; the extension passes its adapters in.
 */
import type {
  CipherAlgorithm,
  Client,
  CompressionAlgorithm,
  ConnectConfig,
  KexAlgorithm,
  MacAlgorithm,
  ServerHostKeyAlgorithm,
  SFTPWrapper,
} from 'ssh2';
import type { SftpServer } from '../config/model';
import { SftpTarget } from '../transport/sftpTarget';
import type { DeploymentTarget } from '../transport/deploymentTarget';
import { transportAlgorithms } from './algorithms';
import {
  createAuthHandler,
  disposeIdentities,
  loadIdentities,
  type Identity,
} from './authentication';
import {
  agentSocketFor,
  resolveConnectionTarget,
  type ConnectionTarget,
  type SshEnvironment,
} from './connectionTarget';
import type { Disposable, FileWatcher } from './fileWatcher';
import {
  HostKeyRejectedError,
  MAX_KNOWN_HOSTS_BYTES,
  hostKeyPolicy,
  readKnownHostsFiles,
} from './hostKeyPolicy';
import type { KeyDerivation } from './keyDerivation';
import { serializePrompts, type PassphrasePrompt } from './passphrase';
import { RemoteWindowError, remoteWindowRefusal } from './remoteWindow';
import type * as Ssh2Bundle from './ssh2Bundle';
import { readRegularFile } from './sshConfigFiles';

export type Ssh2Module = typeof Ssh2Bundle;

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export type DisconnectReason =
  /** Disconnect or Disconnect All was used. */
  | 'requested'
  /** No operation for `idleDisconnectMinutes`. */
  | 'idle'
  /** config.json, an ssh configuration file or known_hosts changed on disk. */
  | 'configurationChanged'
  /** The server's settings were changed in the extension; the next operation reconnects. */
  | 'reconfigured'
  /** The server or the network closed the connection. */
  | 'closed'
  /** Connecting failed. */
  | 'failed'
  /** The extension is shutting down. */
  | 'disposed';

export interface ConnectionStateEvent {
  readonly serverId: string;
  readonly serverName: string;
  readonly status: ConnectionStatus;
  /** Set when `status` is `disconnected`. */
  readonly reason?: DisconnectReason;
}

export interface ServerReference {
  readonly server: SftpServer;
  /** The config.json the server comes from; watched while connected. */
  readonly configFile: string | undefined;
}

export interface ConnectionManagerOptions {
  /** Loads the ssh2 bundle (lazily, on the first connection). */
  readonly ssh2: () => Ssh2Module;
  /** Read at the start of every connection attempt. */
  readonly environment: () => SshEnvironment;
  readonly prompt: PassphrasePrompt;
  readonly deriveKey: KeyDerivation;
  readonly watcher: FileWatcher;
  /**
   * Time allowed for the TCP connection and the key exchange, up to the verified host key.
   * Default 20 s.
   */
  readonly handshakeTimeoutMs?: number;
  /**
   * Time allowed for the server's part of user authentication and opening SFTP. Time spent in
   * the passphrase prompt and in decrypting a key is not counted (the server's own login grace
   * time still applies). Default 30 s.
   */
  readonly authenticationTimeoutMs?: number;
  /** Length of a minute for `idleDisconnectMinutes`; tests shorten it. Default 60 000 ms. */
  readonly minuteMs?: number;
}

/** The next operation after an external change reports this once, then connects anew. */
export class ConfigurationChangedError extends Error {
  constructor(serverName: string, file: string) {
    super(
      `The connection to ${serverName} was closed because ${file} changed outside the ` +
        'extension (configuration changed outside the extension). Check the change and try again.',
    );
    this.name = 'ConfigurationChangedError';
  }
}

const ALL_METHODS_FAILED = 'All configured authentication methods failed';

/** known_hosts lists key types for the host that the server does not offer (any more). */
export class HostKeyTypeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostKeyTypeUnavailableError';
  }
}

export class ConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionError';
  }
}

interface Connection {
  readonly serverId: string;
  readonly serverName: string;
  /** Settings that require a new connection when they change. */
  readonly settingsKey: string;
  readonly idleMinutes: number;
  /** Resolves once connected; rejects when connecting fails. */
  ready: Promise<DeploymentTarget>;
  /** The ssh2 client, from the start of the handshake on. */
  client: Client | undefined;
  /** True once the SFTP session is open. */
  connected: boolean;
  queue: Promise<unknown>;
  pending: number;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  watch: Disposable | undefined;
  /** Set once the connection is closed (or failed); it is then out of the map. */
  closedReason: DisconnectReason | undefined;
  /** Set when a watched file changed while connecting. */
  changedFile: string | undefined;
  /** Aborted when the connection closes: ends prompts and key derivation of the attempt. */
  readonly abort: AbortController;
}

/** A timeout that can be paused while the extension waits for the user. */
class PausableTimeout {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private remaining: number;
  private startedAt = 0;
  private pauses = 0;
  private stopped = false;
  private readonly onTimeout: () => void;

  constructor(ms: number, onTimeout: () => void) {
    this.remaining = ms;
    this.onTimeout = onTimeout;
    this.resume();
  }

  pause(): void {
    this.pauses += 1;
    if (this.pauses === 1 && this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.remaining -= Date.now() - this.startedAt;
    }
  }

  resume(): void {
    if (this.pauses > 0) {
      this.pauses -= 1;
    }
    if (this.pauses > 0 || this.stopped || this.timer !== undefined) {
      return;
    }
    this.startedAt = Date.now();
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.stopped = true;
        this.onTimeout();
      },
      Math.max(this.remaining, 0),
    );
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

function settingsKey(server: SftpServer): string {
  return JSON.stringify([server.connection, server.keepAliveSeconds]);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

/** Removes control characters from text that may come from the server or the network. */
function plain(text: string): string {
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ');
}

type Listener = (event: ConnectionStateEvent) => void;

export class ConnectionManager {
  private readonly connections = new Map<string, Connection>();
  /** Servers whose connection was closed by an external change, with the changed file. */
  private readonly changedOutside = new Map<string, { name: string; file: string }>();
  private readonly listeners = new Set<Listener>();
  private readonly prompt: PassphrasePrompt;
  private ssh2Module: Ssh2Module | undefined;
  private disposed = false;

  private readonly options: ConnectionManagerOptions;

  constructor(options: ConnectionManagerOptions) {
    this.options = options;
    this.prompt = serializePrompts(options.prompt);
  }

  /** Subscribes to connection state changes (for the status bar). */
  onDidChangeState(listener: Listener): Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /** The current state of a server's connection. */
  status(serverId: string): ConnectionStatus {
    const connection = this.connections.get(serverId);
    if (connection === undefined) {
      return 'disconnected';
    }
    return connection.connected ? 'connected' : 'connecting';
  }

  /** Ids of the servers with an open or opening connection. */
  activeServerIds(): string[] {
    return [...this.connections.keys()];
  }

  /**
   * Runs `operation` on the server's connection, connecting first when needed. Operations on
   * the same server run one after another. `operation` gets a frozen copy of the server
   * configuration as it was when this call was made.
   */
  run<T>(
    reference: ServerReference,
    operation: (target: DeploymentTarget, server: Readonly<SftpServer>) => Promise<T>,
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new ConnectionError('The extension is shutting down.'));
    }
    const server = deepFreeze(structuredClone(reference.server));
    const changed = this.changedOutside.get(server.id);
    if (changed !== undefined) {
      this.changedOutside.delete(server.id);
      return Promise.reject(new ConfigurationChangedError(changed.name, changed.file));
    }
    let connection = this.connections.get(server.id);
    if (connection !== undefined && connection.settingsKey !== settingsKey(server)) {
      this.close(connection, 'reconfigured');
      connection = undefined;
    }
    if (connection === undefined) {
      connection = this.open(server, reference.configFile);
    }
    const current = connection;
    const result = current.queue.then(async () => {
      const target = await current.ready;
      if (current.closedReason !== undefined) {
        throw new ConnectionError(`The connection to ${server.name} was closed.`);
      }
      this.stopIdleTimer(current);
      current.pending += 1;
      try {
        return await operation(target, server);
      } finally {
        current.pending -= 1;
        this.startIdleTimer(current);
      }
    });
    current.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Closes the connection of one server, if any. */
  disconnect(serverId: string): void {
    const connection = this.connections.get(serverId);
    if (connection !== undefined) {
      this.close(connection, 'requested');
    }
  }

  /** Closes every connection. */
  disconnectAll(): void {
    for (const connection of [...this.connections.values()]) {
      this.close(connection, 'requested');
    }
  }

  /** Closes everything; later operations fail. */
  dispose(): void {
    this.disposed = true;
    for (const connection of [...this.connections.values()]) {
      this.close(connection, 'disposed');
    }
    this.listeners.clear();
  }

  private emit(event: ConnectionStateEvent): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  private ssh2(): Ssh2Module {
    this.ssh2Module ??= this.options.ssh2();
    return this.ssh2Module;
  }

  private open(server: SftpServer, configFile: string | undefined): Connection {
    const connection: Connection = {
      serverId: server.id,
      serverName: server.name,
      settingsKey: settingsKey(server),
      idleMinutes: server.idleDisconnectMinutes,
      ready: Promise.resolve(undefined as unknown as DeploymentTarget),
      client: undefined,
      connected: false,
      queue: Promise.resolve(),
      pending: 0,
      idleTimer: undefined,
      watch: undefined,
      closedReason: undefined,
      changedFile: undefined,
      abort: new AbortController(),
    };
    this.connections.set(server.id, connection);
    this.emit({ serverId: server.id, serverName: server.name, status: 'connecting' });
    connection.ready = this.connect(connection, server, configFile).then(
      (target) => {
        if (connection.closedReason === undefined) {
          this.emit({ serverId: server.id, serverName: server.name, status: 'connected' });
          this.startIdleTimer(connection);
        }
        return target;
      },
      (error: unknown) => {
        this.close(connection, 'failed');
        // The attempt may have been closed earlier, before its watch existed.
        connection.watch?.dispose();
        connection.watch = undefined;
        throw error;
      },
    );
    return connection;
  }

  private close(connection: Connection, reason: DisconnectReason): void {
    if (connection.closedReason !== undefined) {
      return;
    }
    connection.closedReason = reason;
    connection.abort.abort();
    this.stopIdleTimer(connection);
    connection.watch?.dispose();
    connection.watch = undefined;
    // Also ends a handshake in progress (which may be waiting for an unresponsive server); the
    // attempt then fails as cancelled.
    if (connection.connected) {
      connection.client?.end();
    } else {
      connection.client?.destroy();
    }
    connection.connected = false;
    connection.client = undefined;
    if (this.connections.get(connection.serverId) === connection) {
      this.connections.delete(connection.serverId);
    }
    this.emit({
      serverId: connection.serverId,
      serverName: connection.serverName,
      status: 'disconnected',
      reason,
    });
  }

  private startIdleTimer(connection: Connection): void {
    if (
      connection.idleMinutes <= 0 ||
      connection.pending > 0 ||
      connection.closedReason !== undefined
    ) {
      return;
    }
    this.stopIdleTimer(connection);
    const minute = this.options.minuteMs ?? 60_000;
    connection.idleTimer = setTimeout(() => {
      connection.idleTimer = undefined;
      if (connection.pending === 0) {
        this.close(connection, 'idle');
      }
    }, connection.idleMinutes * minute);
    connection.idleTimer.unref();
  }

  private stopIdleTimer(connection: Connection): void {
    if (connection.idleTimer !== undefined) {
      clearTimeout(connection.idleTimer);
      connection.idleTimer = undefined;
    }
  }

  private onExternalChange(connection: Connection, file: string): void {
    if (connection.closedReason !== undefined) {
      return;
    }
    connection.changedFile ??= file;
    // While connecting, the attempt itself fails with the change; afterwards the next
    // operation reports it.
    if (connection.connected) {
      this.changedOutside.set(connection.serverId, { name: connection.serverName, file });
    }
    this.close(connection, 'configurationChanged');
  }

  private async connect(
    connection: Connection,
    server: SftpServer,
    configFile: string | undefined,
  ): Promise<DeploymentTarget> {
    const env = this.options.environment();
    const refusal = remoteWindowRefusal(env.remoteName);
    if (refusal !== undefined) {
      throw new RemoteWindowError(refusal);
    }
    const ssh2 = this.ssh2();
    const watcher = this.options.watcher;
    // Signatures from before each read, so that a change between reading a file and starting
    // the watch is noticed too.
    const baseline = new Map<string, string>();
    if (configFile !== undefined) {
      baseline.set(configFile, watcher.signature(configFile));
    }
    const target = await resolveConnectionTarget(server.connection, env, (path) => {
      if (!baseline.has(path)) {
        baseline.set(path, watcher.signature(path));
      }
    });
    const watched = [
      ...(configFile === undefined ? [] : [configFile]),
      ...target.configFiles,
      ...target.knownHostsFiles,
    ];
    this.throwIfClosed(connection, server);
    connection.watch = watcher.watch(
      watched,
      (file) => {
        this.onExternalChange(connection, file);
      },
      baseline,
    );

    const knownHosts = await readKnownHostsFiles(target.knownHostsFiles, (path) =>
      readRegularFile(path, MAX_KNOWN_HOSTS_BYTES),
    );
    const policy = hostKeyPolicy(
      knownHosts,
      target.knownHostsFiles,
      target.resolved.knownHostsName,
      {
        alias: target.alias,
        hostName: target.resolved.hostName,
        port: target.resolved.port,
        user: target.resolved.user,
      },
      ssh2.supportedServerHostKeyAlgorithms,
    );
    const algorithms = transportAlgorithms({
      kex: ssh2.supportedKexAlgorithms,
      cipher: ssh2.supportedCipherAlgorithms,
      mac: ssh2.supportedMacAlgorithms,
    });

    const { identities, skipped } = await loadIdentities(
      target.resolved.identityFiles,
      target.resolved.identityFilesAreDefaults,
      (path) => env.readFile(path),
    );
    try {
      this.throwIfClosed(connection, server);
      const agentSocket = server.connection.useSshAgent
        ? agentSocketFor(target.resolved, env)
        : undefined;
      if (server.connection.useSshAgent && agentSocket === undefined) {
        throw new ConnectionError(
          `${server.name} is set to use the SSH agent, but no agent is available ` +
            '(SSH_AUTH_SOCK is not set and IdentityAgent is not configured).',
        );
      }
      if (identities.length === 0 && agentSocket === undefined) {
        const tried = target.resolved.identityFiles.join(', ');
        const problems = skipped.map((entry) => entry.reason).join(' ');
        throw new ConnectionError(
          `No usable private key for ${server.name} (looked for ${tried}).${problems === '' ? '' : ` ${problems}`}`,
        );
      }
      return await this.handshake(connection, server, target, {
        identities,
        agentSocket,
        hostKeyAlgorithms: [...policy.algorithms],
        algorithms,
        checkHostKey: (key) => policy.check(key),
        knownKeyTypes: policy.knownKeyTypes,
      });
    } finally {
      disposeIdentities(identities);
    }
  }

  private throwIfClosed(connection: Connection, server: SftpServer): void {
    if (connection.changedFile !== undefined) {
      throw new ConfigurationChangedError(server.name, connection.changedFile);
    }
    if (connection.closedReason !== undefined) {
      throw new ConnectionError(`Connecting to ${server.name} was cancelled.`);
    }
  }

  private handshake(
    connection: Connection,
    server: SftpServer,
    target: ConnectionTarget,
    settings: {
      identities: readonly Identity[];
      agentSocket: string | undefined;
      hostKeyAlgorithms: string[];
      algorithms: ReturnType<typeof transportAlgorithms>;
      checkHostKey: (key: Buffer) => HostKeyRejectedError | undefined;
      knownKeyTypes: readonly string[];
    },
  ): Promise<DeploymentTarget> {
    const ssh2 = this.ssh2();
    const client = new ssh2.Client();
    connection.client = client;
    const where = `${server.name} (${target.description})`;
    let failure: Error | undefined;
    /** Problems that did not end the attempt (agent errors, refused SHA-1), for the message. */
    const problems: string[] = [];
    const end = (error: Error): void => {
      failure ??= error;
      client.end();
    };
    // For timeouts: the server may not answer at all, so close the socket without a goodbye.
    const destroy = (error: Error): void => {
      failure ??= error;
      client.destroy();
    };
    // Covers TCP and key exchange only; ssh2's own readyTimeout would also count the time the
    // user spends in the passphrase prompt.
    const handshakeTimeout = new PausableTimeout(this.options.handshakeTimeoutMs ?? 20_000, () => {
      destroy(new ConnectionError(`Timed out connecting to ${where} (no SSH key exchange).`));
    });
    let authenticationTimeout: PausableTimeout | undefined;
    const stopTimers = (): void => {
      handshakeTimeout.stop();
      authenticationTimeout?.stop();
    };
    const { handler, methodCount } = createAuthHandler({
      username: target.resolved.user,
      target: target.description,
      identities: settings.identities,
      agentSocket: settings.agentSocket,
      identitiesOnly: target.resolved.identitiesOnly,
      prompt: this.prompt,
      parser: ssh2.utils,
      deriveKey: this.options.deriveKey,
      BaseAgent: ssh2.BaseAgent,
      createAgent: (socket) => ssh2.createAgent(socket),
      onFatalError: end,
      signal: connection.abort.signal,
      onAuthenticationStarted: () => {
        handshakeTimeout.stop();
        authenticationTimeout = new PausableTimeout(
          this.options.authenticationTimeoutMs ?? 30_000,
          () => {
            destroy(new ConnectionError(`Timed out logging in to ${where}.`));
          },
        );
      },
      localWork: async (work) => {
        authenticationTimeout?.pause();
        try {
          return await work();
        } finally {
          authenticationTimeout?.resume();
        }
      },
    });
    if (methodCount === 0) {
      stopTimers();
      return Promise.reject(new ConnectionError(`No authentication method for ${server.name}.`));
    }

    return new Promise<DeploymentTarget>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        stopTimers();
        client.end();
        reject(error);
      };
      client.on('error', (error: Error & { level?: string; code?: string }) => {
        if (failure !== undefined) {
          fail(failure);
          return;
        }
        // ssh2 goes on with the next key or method after these; they only explain a later
        // "all methods failed".
        if (
          error.level === 'agent' ||
          (error.level === 'client-authentication' && error.message !== ALL_METHODS_FAILED)
        ) {
          problems.push(plain(error.message));
          return;
        }
        if (error.level === 'handshake' && error.message.includes('no matching host key format')) {
          fail(
            new HostKeyTypeUnavailableError(
              `${where} no longer offers the key type that known_hosts lists for this host ` +
                `(${settings.knownKeyTypes.join(', ')}). The server may have been reinstalled, ` +
                'or someone may be intercepting the connection: verify with the server ' +
                'administrator. Not connected.',
            ),
          );
          return;
        }
        fail(this.describeError(error, where, settings.identities, problems));
      });
      client.on('close', () => {
        if (!settled) {
          fail(
            failure ??
              (connection.changedFile === undefined
                ? new ConnectionError(
                    `The connection to ${server.name} was closed while connecting.`,
                  )
                : new ConfigurationChangedError(server.name, connection.changedFile)),
          );
          return;
        }
        // Closed later by the server, the network or us. Never reconnect automatically.
        if (connection.client === client) {
          this.close(connection, 'closed');
        }
      });
      client.on('ready', () => {
        client.sftp((error: Error | undefined, sftp: SFTPWrapper) => {
          if (error instanceof Error) {
            fail(new ConnectionError(`${server.name}: the server refused the SFTP subsystem.`));
            return;
          }
          if (connection.closedReason !== undefined) {
            fail(
              connection.changedFile === undefined
                ? new ConnectionError(`Connecting to ${server.name} was cancelled.`)
                : new ConfigurationChangedError(server.name, connection.changedFile),
            );
            return;
          }
          settled = true;
          stopTimers();
          connection.connected = true;
          resolve(new SftpTarget(sftp, target.description));
        });
      });

      const config: ConnectConfig = {
        host: target.resolved.hostName,
        port: target.resolved.port,
        username: target.resolved.user,
        authHandler: handler,
        hostVerifier: (key: Buffer) => {
          const rejection = settings.checkHostKey(key);
          if (rejection !== undefined) {
            failure ??= rejection;
            return false;
          }
          return true;
        },
        // Exact lists (arrays replace ssh2's defaults); see algorithms.ts.
        algorithms: {
          kex: settings.algorithms.kex as KexAlgorithm[],
          cipher: settings.algorithms.cipher as CipherAlgorithm[],
          hmac: settings.algorithms.hmac as MacAlgorithm[],
          compress: settings.algorithms.compress as CompressionAlgorithm[],
          serverHostKey: settings.hostKeyAlgorithms as ServerHostKeyAlgorithm[],
        },
        keepaliveInterval: server.keepAliveSeconds * 1000,
        keepaliveCountMax: 3,
        // Disabled: the timeouts above replace it (see there).
        readyTimeout: 0,
        tryKeyboard: false,
      };
      client.connect(config);
    });
  }

  private describeError(
    error: Error & { level?: string; code?: string },
    where: string,
    identities: readonly Identity[],
    problems: readonly string[],
  ): Error {
    if (error.level === 'client-authentication') {
      const keys = identities.map((identity) => identity.file).join(', ');
      const details = problems.length === 0 ? '' : ` ${problems.join(' ')}`;
      return new ConnectionError(
        `${where} did not accept any of the keys${keys === '' ? '' : ` (${keys})`}.${details}`,
      );
    }
    if (error.code !== undefined && error.level === 'client-socket') {
      return new ConnectionError(`Cannot connect to ${where}: ${plain(error.code)}.`);
    }
    return new ConnectionError(`Connection to ${where} failed: ${plain(error.message)}`);
  }
}
