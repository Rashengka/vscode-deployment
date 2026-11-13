import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { ConnectConfig } from 'ssh2';
import type { SftpServer } from '../../../src/config/model';
import {
  ConnectionError,
  ConnectionManager,
  type ConnectionStateEvent,
  type Ssh2Module,
} from '../../../src/ssh/connectionManager';
import type { SshEnvironment } from '../../../src/ssh/connectionTarget';
import type { FileWatcher } from '../../../src/ssh/fileWatcher';
import { RemoteWindowError } from '../../../src/ssh/remoteWindow';
import * as realSsh2 from '../../../src/ssh/ssh2Bundle';
import {
  TestHome,
  knownHostsLine,
  sftpServer as testServer,
} from '../../support/connectionFixture';

// These tests never reach the network: every case fails before a socket would be opened.
const server: SftpServer = {
  id: 'p1',
  name: 'Production',
  default: true,
  type: 'sftp',
  connection: {
    sshConfigHost: null,
    host: 'app.example.com',
    port: null,
    user: 'deploy',
    identityFile: null,
    useSshAgent: false,
  },
  rootPath: '/var/www/app',
  keepAliveSeconds: 0,
  idleDisconnectMinutes: 0,
  mappings: [],
  excludedLocalPaths: [],
  excludedRemotePaths: [],
};

function environment(patch: Partial<SshEnvironment> = {}): SshEnvironment {
  return {
    homeDirectory: '/home/deploy',
    localUser: 'deploy',
    platform: 'posix',
    systemConfigPath: null,
    agentSocket: undefined,
    remoteName: undefined,
    // An empty machine: no ssh configuration, no keys, no known_hosts.
    readFile: () => Promise.resolve(undefined),
    listDirectory: () => Promise.resolve(undefined),
    ...patch,
  };
}

const noWatch: FileWatcher = {
  signature: () => 'same',
  watch: () => ({ dispose: () => undefined }),
};

function manager(env: SshEnvironment, loads: { count: number }): ConnectionManager {
  return new ConnectionManager({
    ssh2: () => {
      loads.count += 1;
      return {
        supportedServerHostKeyAlgorithms: ['ssh-ed25519'],
        supportedKexAlgorithms: ['curve25519-sha256'],
        supportedCipherAlgorithms: ['aes128-ctr'],
        supportedMacAlgorithms: ['hmac-sha2-256'],
      } as unknown as Ssh2Module;
    },
    environment: () => env,
    prompt: () => Promise.reject(new Error('no prompt expected')),
    deriveKey: () => Promise.reject(new Error('no key derivation expected')),
    watcher: noWatch,
  });
}

describe('ConnectionManager without a server', () => {
  it('refuses in a remote window before loading ssh2 or reading anything', async () => {
    const loads = { count: 0 };
    const reads: string[] = [];
    const connections = manager(
      environment({
        remoteName: 'wsl',
        readFile: (path) => {
          reads.push(path);
          return Promise.resolve(undefined);
        },
      }),
      loads,
    );
    const events: ConnectionStateEvent[] = [];
    connections.onDidChangeState((event) => events.push(event));

    await expect(
      connections.run({ server, configFile: undefined }, () => Promise.resolve()),
    ).rejects.toBeInstanceOf(RemoteWindowError);
    expect(loads.count).toBe(0);
    expect(reads).toEqual([]);
    expect(events.map((event) => [event.status, event.reason])).toEqual([
      ['connecting', undefined],
      ['disconnected', 'failed'],
    ]);
    expect(connections.status('p1')).toBe('disconnected');
  });

  it('fails with the list of files when no key exists', async () => {
    const connections = manager(environment(), { count: 0 });
    await expect(
      connections.run({ server, configFile: undefined }, () => Promise.resolve()),
    ).rejects.toThrow(
      /No usable private key for Production \(looked for \/home\/deploy\/\.ssh\/id_ed25519/,
    );
  });

  it('fails when the agent is enabled but there is none', async () => {
    const connections = manager(environment(), { count: 0 });
    const withAgent = { ...server, connection: { ...server.connection, useSshAgent: true } };
    await expect(
      connections.run({ server: withAgent, configFile: undefined }, () => Promise.resolve()),
    ).rejects.toThrow(/use the SSH agent, but no agent is available/);
  });

  it('rejects every operation after dispose', async () => {
    const connections = manager(environment(), { count: 0 });
    connections.dispose();
    await expect(
      connections.run({ server, configFile: undefined }, () => Promise.resolve()),
    ).rejects.toBeInstanceOf(ConnectionError);
  });
});

describe('ConnectionManager options passed to ssh2', () => {
  it('passes neither key nor passphrase, no debug hook, exact algorithm lists and no agent forwarding', async () => {
    const home = new TestHome();
    try {
      const pair = realSsh2.utils.generateKeyPairSync('ed25519', {
        passphrase: 'not-used-here',
        cipher: 'aes256-ctr',
        rounds: 4,
      });
      const key = home.writeKey('id_ed25519', Buffer.from(pair.private));
      home.writeConfig([{ alias: 'test', port: 2222, identityFiles: [key] }]);
      const hostKey = realSsh2.utils
        .generateKeyPairSync('ed25519')
        .public.split(' ')
        .slice(0, 2)
        .join(' ');
      home.writeKnownHosts(knownHostsLine(2222, hostKey));
      const captured: ConnectConfig[] = [];
      class FakeClient extends EventEmitter {
        connect(config: ConnectConfig): void {
          captured.push(config);
          setImmediate(() => {
            this.emit(
              'error',
              Object.assign(new Error('refused'), { level: 'client-socket', code: 'ECONNREFUSED' }),
            );
          });
        }
        end(): void {
          setImmediate(() => this.emit('close'));
        }
        destroy(): void {
          this.end();
        }
      }
      const connections = new ConnectionManager({
        ssh2: () => ({ ...realSsh2, Client: FakeClient }) as unknown as Ssh2Module,
        environment: () => home.environment(),
        prompt: () => Promise.reject(new Error('no prompt expected')),
        deriveKey: () => Promise.reject(new Error('no key derivation expected')),
        watcher: noWatch,
      });

      await expect(
        connections.run({ server: testServer('a', 'test'), configFile: undefined }, () =>
          Promise.resolve(),
        ),
      ).rejects.toThrow('Cannot connect to Test a (deploy@127.0.0.1:2222): ECONNREFUSED.');

      expect(captured).toHaveLength(1);
      const config = captured[0] as ConnectConfig & Record<string, unknown>;
      for (const option of [
        'privateKey',
        'passphrase',
        'password',
        'debug',
        'agent',
        'agentForward',
        'hostHash',
      ]) {
        expect(config[option], option).toBeUndefined();
      }
      expect(typeof config.authHandler).toBe('function');
      expect(typeof config.hostVerifier).toBe('function');
      expect(config.tryKeyboard).toBe(false);
      // ssh2's readyTimeout would count the passphrase prompt; our own timeouts replace it.
      expect(config.readyTimeout).toBe(0);
      expect(config.algorithms?.serverHostKey).toEqual(['ssh-ed25519']);
      for (const list of ['kex', 'cipher', 'hmac', 'compress'] as const) {
        expect(Array.isArray(config.algorithms?.[list]), list).toBe(true);
      }
      expect(JSON.stringify(config.algorithms)).not.toMatch(/sha1|cbc|zlib/);
    } finally {
      home.cleanup();
    }
  });
});

describe('ConnectionManager watches', () => {
  it('disposes a watch created after the attempt was already closed', async () => {
    let watches = 0;
    let disposes = 0;
    const counting: FileWatcher = {
      signature: () => 'same',
      watch: () => {
        watches += 1;
        return {
          dispose: () => {
            disposes += 1;
          },
        };
      },
    };
    let releaseRead: () => void = () => undefined;
    const readStarted = new Promise<void>((started) => {
      releaseRead = started;
    });
    let finishRead: (value: string | undefined) => void = () => undefined;
    const connections = new ConnectionManager({
      ssh2: () => realSsh2,
      environment: () =>
        environment({
          // The ssh configuration is still being read when the connection is closed.
          readFile: () => {
            releaseRead();
            return new Promise((resolve) => {
              finishRead = resolve;
            });
          },
        }),
      prompt: () => Promise.reject(new Error('no prompt expected')),
      deriveKey: () => Promise.reject(new Error('no key derivation expected')),
      watcher: counting,
    });

    const attempt = connections
      .run({ server, configFile: undefined }, () => Promise.resolve())
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );
    await readStarted;
    connections.disconnectAll();
    finishRead(undefined);

    expect(await attempt).toBeInstanceOf(ConnectionError);
    expect(disposes).toBe(watches);
  });
});
