import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  ConfigurationChangedError,
  ConnectionManager,
  HostKeyTypeUnavailableError,
  type ConnectionStateEvent,
  type Ssh2Module,
} from '../../src/ssh/connectionManager';
import type { SshEnvironment } from '../../src/ssh/connectionTarget';
import { nodeFileWatcher } from '../../src/ssh/fileWatcher';
import { HostKeyRejectedError } from '../../src/ssh/hostKeyPolicy';
import { workerKeyDerivation } from '../../src/ssh/keyDerivation';
import { sha256Fingerprint } from '../../src/ssh/knownHosts';
import {
  PassphraseCancelledError,
  TooManyPassphraseAttemptsError,
  type PassphrasePrompt,
} from '../../src/ssh/passphrase';
import { RemoteWindowError } from '../../src/ssh/remoteWindow';
import type { DeploymentTarget } from '../../src/transport/deploymentTarget';
import { ScriptedPrompt, TestHome, knownHostsLine, sftpServer } from '../support/connectionFixture';
import { startSshd, type GeneratedKey, type SshdContainer } from '../support/sshd';

const realpath = (target: DeploymentTarget): Promise<string> => target.realpath('.');

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
}

describe('ConnectionManager against a local OpenSSH server', () => {
  let sshd: SshdContainer | undefined;
  let ssh2: Ssh2Module;
  let workerFile: string;
  let encrypted: GeneratedKey;
  const passphrase = randomBytes(12).toString('hex');
  const homes: TestHome[] = [];
  const managers: ConnectionManager[] = [];

  beforeAll(async () => {
    const dist = join(inject('unpackedExtension'), 'dist');
    ssh2 = createRequire(join(dist, 'ssh2.js'))(join(dist, 'ssh2.js')) as Ssh2Module;
    workerFile = join(dist, 'kdfWorker.js');
    sshd = await startSshd();
    encrypted = await sshd.generateKey({ type: 'ed25519', passphrase, authorize: true });
  }, 180_000);

  afterEach(() => {
    for (const manager of managers.splice(0)) {
      manager.dispose();
    }
    for (const home of homes.splice(0)) {
      home.cleanup();
    }
  });

  afterAll(async () => {
    await sshd?.stop();
  });

  function server(): SshdContainer {
    if (sshd === undefined) {
      throw new Error('The test SSH server did not start.');
    }
    return sshd;
  }

  /** The unencrypted client key the container authorizes at start-up. */
  function clientKey(): GeneratedKey {
    return { content: Buffer.from(server().clientConfig.privateKey), publicKey: '' };
  }

  /** A home with the alias `test` for the server and its ed25519 host key in known_hosts. */
  function setup(
    keys: readonly { name: string; key: GeneratedKey; withPub?: boolean }[],
    knownHosts?: string,
  ): TestHome {
    const home = new TestHome();
    homes.push(home);
    const files = keys.map(({ name, key, withPub }) =>
      home.writeKey(name, key.content, withPub === true ? key.publicKey : undefined),
    );
    home.writeConfig([{ alias: 'test', port: server().clientConfig.port, identityFiles: files }]);
    home.writeKnownHosts(
      knownHosts ??
        knownHostsLine(server().clientConfig.port, server().hostKeyLines['ssh-ed25519']),
    );
    return home;
  }

  function manager(
    home: TestHome,
    prompt: ScriptedPrompt,
    options: {
      minuteMs?: number;
      env?: Partial<SshEnvironment>;
      prompt?: PassphrasePrompt;
      timeoutMs?: number;
    } = {},
  ): ConnectionManager {
    const created = new ConnectionManager({
      ssh2: () => ssh2,
      environment: () => home.environment(options.env),
      prompt: options.prompt ?? prompt.prompt,
      deriveKey: workerKeyDerivation(workerFile),
      watcher: nodeFileWatcher,
      ...(options.minuteMs === undefined ? {} : { minuteMs: options.minuteMs }),
      ...(options.timeoutMs === undefined
        ? {}
        : { handshakeTimeoutMs: options.timeoutMs, authenticationTimeoutMs: options.timeoutMs }),
    });
    managers.push(created);
    return created;
  }

  const testServer = { server: sftpServer('a', 'test'), configFile: undefined };

  it('connects with a passphrase-protected OpenSSH key and asks once', async () => {
    const home = setup([{ name: 'id_ed25519', key: encrypted }]);
    const prompt = new ScriptedPrompt([passphrase]);
    const connections = manager(home, prompt);

    await expect(connections.run(testServer, realpath)).resolves.toBe('/home/deploy');
    expect(prompt.requests).toHaveLength(1);
    expect(prompt.requests[0]?.keyFile).toBe(join(home.sshDir, 'id_ed25519'));
    expect(connections.status('a')).toBe('connected');
  });

  it('asks again after a wrong passphrase and connects on the third attempt', async () => {
    const home = setup([{ name: 'id_ed25519', key: encrypted }]);
    const prompt = new ScriptedPrompt(['wrong-1', 'wrong-2', passphrase]);

    await expect(manager(home, prompt).run(testServer, realpath)).resolves.toBe('/home/deploy');
    expect(
      prompt.requests.map((request) => [request.attempt, request.previousAttemptFailed]),
    ).toEqual([
      [1, false],
      [2, true],
      [3, true],
    ]);
  });

  it('gives up after three wrong passphrases with a message that contains no secret', async () => {
    const home = setup([{ name: 'id_ed25519', key: encrypted }]);
    const wrong = ['wrong-a1', 'wrong-b2', 'wrong-c3'];
    const connections = manager(home, new ScriptedPrompt(wrong));

    const error = await rejectionOf(connections.run(testServer, realpath));

    expect(error).toBeInstanceOf(TooManyPassphraseAttemptsError);
    const message = (error as Error).message;
    expect(message).toContain(join(home.sshDir, 'id_ed25519'));
    for (const secret of [...wrong, passphrase]) {
      expect(message).not.toContain(secret);
    }
    expect(message).not.toMatch(/PRIVATE KEY|AAAA/);
    expect(connections.status('a')).toBe('disconnected');
  });

  it('stops when the prompt is cancelled', async () => {
    const home = setup([{ name: 'id_ed25519', key: encrypted }]);

    await expect(
      manager(home, new ScriptedPrompt([undefined])).run(testServer, realpath),
    ).rejects.toBeInstanceOf(PassphraseCancelledError);
  });

  it('connects with an unencrypted key without asking', async () => {
    const home = setup([{ name: 'id_ed25519', key: clientKey() }]);
    const prompt = new ScriptedPrompt([]);

    await expect(manager(home, prompt).run(testServer, realpath)).resolves.toBe('/home/deploy');
    expect(prompt.requests).toHaveLength(0);
  });

  it.each([
    ['an encrypted PEM RSA key', { type: 'rsa', format: 'PEM' }],
    ['an encrypted OpenSSH RSA key', { type: 'rsa' }],
    ['an encrypted OpenSSH ECDSA key', { type: 'ecdsa' }],
    ['an encrypted PEM ECDSA key', { type: 'ecdsa', format: 'PEM' }],
  ] as const)('connects with %s generated by ssh-keygen', async (_, options) => {
    const key = await server().generateKey({ ...options, passphrase, authorize: true });
    // PEM files carry no public key; with the .pub next to it the key is offered first.
    const home = setup([{ name: 'id_test', key, withPub: true }]);
    const prompt = new ScriptedPrompt([passphrase]);

    await expect(manager(home, prompt).run(testServer, realpath)).resolves.toBe('/home/deploy');
    expect(prompt.requests).toHaveLength(1);
  });

  it('decrypts an encrypted PEM key without a .pub file before offering it', async () => {
    const key = await server().generateKey({
      type: 'rsa',
      format: 'PEM',
      passphrase,
      authorize: true,
    });
    const home = setup([{ name: 'id_rsa', key }]);
    const prompt = new ScriptedPrompt([passphrase]);

    await expect(manager(home, prompt).run(testServer, realpath)).resolves.toBe('/home/deploy');
    expect(prompt.requests).toHaveLength(1);
  });

  it('asks only for the passphrase of the key the server accepts', async () => {
    const other = await server().generateKey({
      type: 'ed25519',
      passphrase: 'other-pass',
      authorize: false,
    });
    const home = setup([
      { name: 'id_other', key: other },
      { name: 'id_ed25519', key: encrypted },
    ]);
    const prompt = new ScriptedPrompt([passphrase]);

    await manager(home, prompt).run(testServer, realpath);

    expect(prompt.requests.map((request) => request.keyFile)).toEqual([
      join(home.sshDir, 'id_ed25519'),
    ]);
  });

  describe('host keys', () => {
    it('rejects an unknown host with its SHA256 fingerprint and the ssh advice', async () => {
      const home = setup([{ name: 'id_ed25519', key: clientKey() }], '');
      const prompt = new ScriptedPrompt([]);

      const error = await rejectionOf(manager(home, prompt).run(testServer, realpath));

      expect(error).toBeInstanceOf(HostKeyRejectedError);
      const rejected = error as HostKeyRejectedError;
      expect(rejected.problem).toBe('unknown');
      expect(rejected.fingerprint).toBe(sha256Fingerprint(server().hostKey));
      expect(rejected.message).toContain(rejected.fingerprint);
      expect(rejected.message).toContain('"ssh test"');
      expect(prompt.requests).toHaveLength(0);
    });

    it('rejects a changed host key with the man-in-the-middle warning', async () => {
      const other = await server().generateKey({
        type: 'ed25519',
        passphrase: '',
        authorize: false,
      });
      const otherHostKey = other.publicKey.split(' ').slice(0, 2).join(' ');
      const home = setup(
        [{ name: 'id_ed25519', key: clientKey() }],
        knownHostsLine(server().clientConfig.port, otherHostKey),
      );

      const error = await rejectionOf(
        manager(home, new ScriptedPrompt([])).run(testServer, realpath),
      );

      expect(error).toBeInstanceOf(HostKeyRejectedError);
      const rejected = error as HostKeyRejectedError;
      expect(rejected.problem).toBe('changed');
      expect(rejected.message).toContain('possible man-in-the-middle');
      expect(rejected.message).toContain('server administrator');
      expect(rejected.message).not.toMatch(/ssh-keygen -R|remove|trust anyway/i);
    });

    it('rejects a revoked host key', async () => {
      const port = server().clientConfig.port;
      const line = server().hostKeyLines['ssh-ed25519'];
      const home = setup(
        [{ name: 'id_ed25519', key: clientKey() }],
        `${knownHostsLine(port, line)}@revoked * ${line}\n`,
      );

      await expect(
        manager(home, new ScriptedPrompt([])).run(testServer, realpath),
      ).rejects.toMatchObject({ problem: 'revoked' });
    });

    it('explains when the server no longer offers the key type known_hosts lists', async () => {
      const p384 = ssh2.utils
        .generateKeyPairSync('ecdsa', { bits: 384 })
        .public.split(' ')
        .slice(0, 2)
        .join(' ');
      const home = setup(
        [{ name: 'id_ed25519', key: clientKey() }],
        knownHostsLine(server().clientConfig.port, p384),
      );

      const error = await rejectionOf(
        manager(home, new ScriptedPrompt([])).run(testServer, realpath),
      );

      expect(error).toBeInstanceOf(HostKeyTypeUnavailableError);
      expect((error as Error).message).toContain('ecdsa-sha2-nistp384');
      expect((error as Error).message).toContain('verify with the server administrator');
    });

    it.each(['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ssh-rsa'] as const)(
      'connects to a server with several host keys when known_hosts has only %s',
      async (type) => {
        const home = setup(
          [{ name: 'id_ed25519', key: clientKey() }],
          knownHostsLine(server().clientConfig.port, server().hostKeyLines[type]),
        );

        await expect(manager(home, new ScriptedPrompt([])).run(testServer, realpath)).resolves.toBe(
          '/home/deploy',
        );
      },
    );

    it('accepts a hashed known_hosts entry (ssh-keygen -H) for a non-standard port', async () => {
      const port = server().clientConfig.port;
      expect(port).not.toBe(22);
      const hashed = await server().hashKnownHosts(
        knownHostsLine(port, server().hostKeyLines['ssh-ed25519']),
      );
      expect(hashed).toMatch(/^\|1\|/);
      expect(hashed).not.toContain('127.0.0.1');
      const home = setup([{ name: 'id_ed25519', key: clientKey() }], hashed);

      await expect(manager(home, new ScriptedPrompt([])).run(testServer, realpath)).resolves.toBe(
        '/home/deploy',
      );
    });

    it('never writes to known_hosts (host keys announced after login are ignored)', async () => {
      const home = setup([{ name: 'id_ed25519', key: clientKey() }]);
      const before = readFileSync(home.knownHostsPath);
      const connections = manager(home, new ScriptedPrompt([]));

      await connections.run(testServer, async (target) => {
        // Give the server time to send its host key announcement.
        await new Promise((resolve) => setTimeout(resolve, 500));
        return realpath(target);
      });

      expect(readFileSync(home.knownHostsPath).equals(before)).toBe(true);
      expect(connections.status('a')).toBe('connected');
    });
  });

  describe('connection lifetime', () => {
    function events(connections: ConnectionManager): ConnectionStateEvent[] {
      const seen: ConnectionStateEvent[] = [];
      connections.onDidChangeState((event) => seen.push(event));
      return seen;
    }

    async function waitFor(condition: () => boolean, what: string): Promise<void> {
      const deadline = Date.now() + 10_000;
      while (!condition()) {
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for ${what}.`);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

    it('disconnects when idle and asks for the passphrase again on the next operation', async () => {
      const home = setup([{ name: 'id_ed25519', key: encrypted }]);
      const prompt = new ScriptedPrompt([passphrase, passphrase]);
      const connections = manager(home, prompt, { minuteMs: 300 });
      const seen = events(connections);
      const reference = {
        server: sftpServer('a', 'test', { idleDisconnectMinutes: 1 }),
        configFile: undefined,
      };

      await connections.run(reference, realpath);
      await waitFor(() => seen.some((event) => event.reason === 'idle'), 'the idle disconnect');
      expect(connections.status('a')).toBe('disconnected');
      expect(prompt.requests).toHaveLength(1);

      await expect(connections.run(reference, realpath)).resolves.toBe('/home/deploy');
      expect(prompt.requests).toHaveLength(2);
    });

    it('keeps the connection when the idle limit is 0', async () => {
      const home = setup([{ name: 'id_ed25519', key: clientKey() }]);
      const connections = manager(home, new ScriptedPrompt([]), { minuteMs: 50 });

      await connections.run(testServer, realpath);
      await new Promise((resolve) => setTimeout(resolve, 400));

      expect(connections.status('a')).toBe('connected');
    });

    it('disconnects all servers and does not reconnect without a new passphrase', async () => {
      const home = setup([{ name: 'id_ed25519', key: encrypted }]);
      const port = server().clientConfig.port;
      const key = join(home.sshDir, 'id_ed25519');
      home.writeConfig([
        { alias: 'one', port, identityFiles: [key] },
        { alias: 'two', port, identityFiles: [key] },
      ]);
      const prompt = new ScriptedPrompt([passphrase, passphrase, passphrase]);
      const connections = manager(home, prompt);
      const seen = events(connections);
      const one = { server: sftpServer('one', 'one'), configFile: undefined };
      const two = { server: sftpServer('two', 'two'), configFile: undefined };

      await Promise.all([connections.run(one, realpath), connections.run(two, realpath)]);
      expect(prompt.maxConcurrent).toBe(1);
      expect(connections.activeServerIds().sort()).toEqual(['one', 'two']);

      connections.disconnectAll();

      expect(connections.activeServerIds()).toEqual([]);
      expect(
        seen
          .filter((event) => event.status === 'disconnected')
          .map((event) => [event.serverId, event.reason]),
      ).toEqual([
        ['one', 'requested'],
        ['two', 'requested'],
      ]);
      await connections.run(one, realpath);
      expect(prompt.requests).toHaveLength(3);
    });

    it('runs operations on one server one after another', async () => {
      const home = setup([{ name: 'id_ed25519', key: clientKey() }]);
      const connections = manager(home, new ScriptedPrompt([]));
      const log: string[] = [];
      const operation = (name: string) => async (): Promise<void> => {
        log.push(`${name} start`);
        await new Promise((resolve) => setTimeout(resolve, 50));
        log.push(`${name} end`);
      };

      await Promise.all([
        connections.run(testServer, operation('first')),
        connections.run(testServer, operation('second')),
      ]);

      expect(log).toEqual(['first start', 'first end', 'second start', 'second end']);
    });

    it('gives each operation a frozen snapshot of the configuration', async () => {
      const home = setup([{ name: 'id_ed25519', key: clientKey() }]);
      const connections = manager(home, new ScriptedPrompt([]));
      const original = { ...sftpServer('a', 'test'), rootPath: '/var/www/app' };

      const seenRoot = await connections.run(
        { server: original, configFile: undefined },
        async (_target, snapshot) => {
          original.rootPath = '/changed';
          await Promise.resolve();
          expect(Object.isFrozen(snapshot)).toBe(true);
          expect(Object.isFrozen(snapshot.connection)).toBe(true);
          return snapshot.rootPath;
        },
      );

      expect(seenRoot).toBe('/var/www/app');
    });

    it.each(['known_hosts', 'ssh config', 'config.json'] as const)(
      'closes the connection when %s changes and reports it once',
      async (changed) => {
        const home = setup([{ name: 'id_ed25519', key: clientKey() }]);
        const configFile = join(home.root, 'config.json');
        appendFileSync(configFile, '{}\n');
        const connections = manager(home, new ScriptedPrompt([]));
        const seen = events(connections);
        const reference = { server: sftpServer('a', 'test'), configFile };
        await connections.run(reference, realpath);

        const file = {
          known_hosts: home.knownHostsPath,
          'ssh config': home.configPath,
          'config.json': configFile,
        }[changed];
        appendFileSync(file, '\n# changed\n');
        await waitFor(
          () => seen.some((event) => event.reason === 'configurationChanged'),
          'the close',
        );

        expect(connections.status('a')).toBe('disconnected');
        await expect(connections.run(reference, realpath)).rejects.toBeInstanceOf(
          ConfigurationChangedError,
        );
        await expect(connections.run(reference, realpath)).resolves.toBe('/home/deploy');
      },
    );

    it('cancels a connection attempt that is waiting for the passphrase on Disconnect All', async () => {
      const home = setup([{ name: 'id_ed25519', key: encrypted }]);
      let answer: ((value: Buffer | undefined) => void) | undefined;
      let shown: () => void = () => undefined;
      const asked = new Promise<void>((resolve) => {
        shown = resolve;
      });
      const connections = new ConnectionManager({
        ssh2: () => ssh2,
        environment: () => home.environment(),
        prompt: () =>
          new Promise((done) => {
            answer = done;
            shown();
          }),
        deriveKey: workerKeyDerivation(workerFile),
        watcher: nodeFileWatcher,
      });
      managers.push(connections);
      const seen = events(connections);

      const attempt = rejectionOf(connections.run(testServer, realpath));
      await asked;
      expect(connections.status('a')).toBe('connecting');
      connections.disconnectAll();
      answer?.(Buffer.from(passphrase));

      expect(await attempt).toBeInstanceOf(Error);
      expect(connections.status('a')).toBe('disconnected');
      expect(seen.map((event) => event.reason ?? event.status)).toEqual([
        'connecting',
        'requested',
      ]);
    });

    it.skipIf(process.platform === 'win32')(
      'closes the connection when the file a symlinked ssh config points to changes',
      async () => {
        const home = setup([{ name: 'id_ed25519', key: clientKey() }]);
        const real = join(home.root, 'dotfiles-ssh-config');
        renameSync(home.configPath, real);
        symlinkSync(real, home.configPath);
        const connections = manager(home, new ScriptedPrompt([]));
        const seen = events(connections);
        await connections.run(testServer, realpath);

        // Saved like an editor does: a new file renamed over the target.
        writeFileSync(`${real}.tmp`, `${readFileSync(real, 'utf8')}\n# changed\n`);
        renameSync(`${real}.tmp`, real);
        await waitFor(
          () => seen.some((event) => event.reason === 'configurationChanged'),
          'the close',
        );
        expect(connections.status('a')).toBe('disconnected');
      },
    );

    it('lets the next connection prompt when an unanswered prompt is ended by Disconnect All', async () => {
      const home = setup([{ name: 'id_ed25519', key: encrypted }]);
      const port = server().clientConfig.port;
      const key = join(home.sshDir, 'id_ed25519');
      home.writeConfig([
        { alias: 'one', port, identityFiles: [key] },
        { alias: 'two', port, identityFiles: [key] },
      ]);
      const signals: AbortSignal[] = [];
      let firstShown: () => void = () => undefined;
      const shown = new Promise<void>((resolve) => {
        firstShown = resolve;
      });
      const prompt: PassphrasePrompt = (request) => {
        signals.push(request.signal);
        if (signals.length === 1) {
          firstShown();
          // Never answered, like an input box the user walked away from.
          return new Promise(() => undefined);
        }
        return Promise.resolve(Buffer.from(passphrase));
      };
      const connections = manager(home, new ScriptedPrompt([]), { prompt });

      const first = rejectionOf(
        connections.run({ server: sftpServer('one', 'one'), configFile: undefined }, realpath),
      );
      await shown;
      connections.disconnectAll();
      expect(signals[0]?.aborted).toBe(true);
      expect(await first).toBeInstanceOf(Error);

      const started = Date.now();
      await expect(
        connections.run({ server: sftpServer('two', 'two'), configFile: undefined }, realpath),
      ).resolves.toBe('/home/deploy');
      expect(signals).toHaveLength(2);
      expect(Date.now() - started).toBeLessThan(1_000);
    });

    it('refuses to connect in a remote window', async () => {
      const home = setup([{ name: 'id_ed25519', key: encrypted }]);
      const prompt = new ScriptedPrompt([]);

      await expect(
        manager(home, prompt, { env: { remoteName: 'ssh-remote' } }).run(testServer, realpath),
      ).rejects.toBeInstanceOf(RemoteWindowError);
      expect(prompt.requests).toHaveLength(0);
    });
  });

  describe('timeouts', () => {
    const silentServers: Server[] = [];
    const sockets: Socket[] = [];

    afterEach(async () => {
      for (const socket of sockets.splice(0)) {
        socket.destroy();
      }
      for (const silent of silentServers.splice(0)) {
        await new Promise<void>((resolve) => {
          silent.close(() => {
            resolve();
          });
        });
      }
    });

    it('does not count the time in the passphrase prompt against the timeouts', async () => {
      const home = setup([{ name: 'id_ed25519', key: encrypted }]);
      const slowPrompt: PassphrasePrompt = () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve(Buffer.from(passphrase));
          }, 2_500);
        });

      await expect(
        manager(home, new ScriptedPrompt([]), { prompt: slowPrompt, timeoutMs: 1_500 }).run(
          testServer,
          realpath,
        ),
      ).resolves.toBe('/home/deploy');
    });

    it.each([
      ['accepts the TCP connection but never answers', ''],
      ['sends its banner but never completes the key exchange', 'SSH-2.0-OpenSSH_9.9\r\n'],
    ])('times out when a server %s', async (_, banner) => {
      const silent = createServer((socket) => {
        sockets.push(socket);
        if (banner !== '') {
          socket.write(banner);
        }
      });
      silentServers.push(silent);
      await new Promise<void>((resolve) => {
        silent.listen(0, '127.0.0.1', resolve);
      });
      const address = silent.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      const home = setup([{ name: 'id_ed25519', key: clientKey() }]);
      home.writeConfig([{ alias: 'test', port, identityFiles: [join(home.sshDir, 'id_ed25519')] }]);
      home.writeKnownHosts(knownHostsLine(port, server().hostKeyLines['ssh-ed25519']));

      const started = Date.now();
      const error = await rejectionOf(
        manager(home, new ScriptedPrompt([]), { timeoutMs: 1_500 }).run(testServer, realpath),
      );

      expect((error as Error).message).toMatch(/Timed out connecting to .*no SSH key exchange/);
      expect(Date.now() - started).toBeLessThan(5_000);
    });
  });

  // A Unix socket agent; Windows uses named pipes, and the integration tests run on Linux.
  describe.skipIf(process.platform === 'win32')('SSH agent (opt-in)', () => {
    let agentServer: Server | undefined;

    afterEach(async () => {
      const running = agentServer;
      agentServer = undefined;
      if (running !== undefined) {
        await new Promise<void>((resolve) => {
          running.close(() => {
            resolve();
          });
        });
      }
    });

    /**
     * A minimal SSH agent on a Unix socket in the test home that serves one unencrypted key
     * (ssh2's AgentProtocol in server mode). It is not the user's agent and is never forwarded.
     */
    async function startAgent(
      home: TestHome,
      content: Buffer,
      extra: readonly { content: Buffer; passphrase?: string }[] = [],
    ): Promise<{ socket: string; signs: number[] }> {
      const require = createRequire(import.meta.url);
      // Test infrastructure loads ssh2 from node_modules; extension code never does.
      const { AgentProtocol, utils } = require('ssh2') as typeof import('ssh2');
      const keys = [{ content, passphrase: undefined }, ...extra].map((entry) => {
        const key = utils.parseKey(
          entry.content,
          entry.passphrase === undefined ? undefined : Buffer.from(entry.passphrase),
        );
        if (key instanceof Error) {
          throw new Error('The test agent key could not be parsed.');
        }
        return key;
      });
      const signs: number[] = [];
      const socket = join(home.root, 'agent.sock');
      const created = createServer((stream) => {
        const protocol = new AgentProtocol(false);
        protocol.on('identities', (request) => {
          protocol.getIdentitiesReply(request, keys);
        });
        protocol.on('sign', (request, publicKey, data, options) => {
          signs.push(data.length);
          const key = keys.find((candidate) =>
            candidate.getPublicSSH().equals(publicKey.getPublicSSH()),
          );
          const signature =
            key === undefined ? new Error('unknown key') : key.sign(data, options.hash);
          if (signature instanceof Error) {
            protocol.failureReply(request);
          } else {
            protocol.signReply(request, signature);
          }
        });
        stream.pipe(protocol).pipe(stream);
      });
      agentServer = created;
      await new Promise<void>((resolve) => {
        created.listen(socket, resolve);
      });
      return { socket, signs };
    }

    const withAgent = (): { server: ReturnType<typeof sftpServer>; configFile: undefined } => {
      const base = sftpServer('a', 'test');
      return {
        server: { ...base, connection: { ...base.connection, useSshAgent: true } },
        configFile: undefined,
      };
    };

    function agentHome(identitiesOnly: boolean): TestHome {
      const home = setup([]);
      home.writeConfig([
        { alias: 'test', port: server().clientConfig.port, identityFiles: [], identitiesOnly },
      ]);
      return home;
    }

    it('authenticates through the agent when useSshAgent is on', async () => {
      const home = agentHome(false);
      const agent = await startAgent(home, clientKey().content);
      const prompt = new ScriptedPrompt([]);

      await expect(
        manager(home, prompt, { env: { agentSocket: agent.socket } }).run(withAgent(), realpath),
      ).resolves.toBe('/home/deploy');
      expect(agent.signs).toHaveLength(1);
      expect(prompt.requests).toHaveLength(0);
    });

    it('offers only agent keys of the identity files with IdentitiesOnly yes', async () => {
      const home = agentHome(true);
      const agent = await startAgent(home, clientKey().content);

      await expect(
        manager(home, new ScriptedPrompt([]), { env: { agentSocket: agent.socket } }).run(
          withAgent(),
          realpath,
        ),
      ).rejects.toThrow(/did not accept any of the keys/);
      expect(agent.signs).toEqual([]);
    });

    it('signs with the agent key that matches an identity file with IdentitiesOnly yes', async () => {
      const home = setup([{ name: 'id_ed25519', key: encrypted }]);
      home.writeConfig([
        {
          alias: 'test',
          port: server().clientConfig.port,
          identityFiles: [join(home.sshDir, 'id_ed25519')],
          identitiesOnly: true,
        },
      ]);
      const stranger = ssh2.utils.generateKeyPairSync('ed25519').private;
      // The agent holds a key the config does not name (first) and the identity file's key.
      const agent = await startAgent(home, Buffer.from(stranger), [
        { content: encrypted.content, passphrase },
      ]);
      const prompt = new ScriptedPrompt([]);

      await expect(
        manager(home, prompt, { env: { agentSocket: agent.socket } }).run(withAgent(), realpath),
      ).resolves.toBe('/home/deploy');
      expect(agent.signs).toHaveLength(1);
      expect(prompt.requests).toHaveLength(0);
    });

    it('continues with the identity files when the agent socket does not exist', async () => {
      const home = setup([{ name: 'id_ed25519', key: clientKey() }]);
      const missing = join(home.root, 'no-agent.sock');
      rmSync(missing, { force: true });

      await expect(
        manager(home, new ScriptedPrompt([]), { env: { agentSocket: missing } }).run(
          withAgent(),
          realpath,
        ),
      ).resolves.toBe('/home/deploy');
    });

    it('does not use the agent when useSshAgent is off', async () => {
      const home = agentHome(false);
      const agent = await startAgent(home, clientKey().content);

      await expect(
        manager(home, new ScriptedPrompt([]), { env: { agentSocket: agent.socket } }).run(
          testServer,
          realpath,
        ),
      ).rejects.toThrow(/No usable private key/);
      expect(agent.signs).toEqual([]);
    });
  });
});
