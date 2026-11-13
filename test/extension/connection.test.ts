import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ConnectionManager, type Ssh2Module } from '../../src/ssh/connectionManager';
import { nodeFileWatcher } from '../../src/ssh/fileWatcher';
import { HostKeyRejectedError } from '../../src/ssh/hostKeyPolicy';
import { workerKeyDerivation } from '../../src/ssh/keyDerivation';
import { ScriptedPrompt, TestHome, knownHostsLine, sftpServer } from '../support/connectionFixture';
import { startSshd, type GeneratedKey, type SshdContainer } from '../support/sshd';
import { extensionUnderTest } from './extensionUnderTest';

// Runs the connection code in the extension host (Electron's Node.js and BoringSSL), with the
// ssh2 bundle and key derivation worker from the installed package. The integration tests
// cover the same code on plain Node.js; negotiated algorithms can differ between the two.
describe('ConnectionManager inside the VS Code extension host', () => {
  const passphrase = randomBytes(12).toString('hex');
  let sshd: SshdContainer | undefined;
  let key: GeneratedKey | undefined;
  let ssh2: Ssh2Module;
  let workerFile: string;
  const homes: TestHome[] = [];
  const managers: ConnectionManager[] = [];

  before(async () => {
    const dist = join(extensionUnderTest().extensionPath, 'dist');
    ssh2 = createRequire(join(dist, 'ssh2.js'))(join(dist, 'ssh2.js')) as Ssh2Module;
    workerFile = join(dist, 'kdfWorker.js');
    sshd = await startSshd();
    key = await sshd.generateKey({ type: 'ed25519', passphrase, authorize: true });
  });

  afterEach(() => {
    for (const manager of managers.splice(0)) {
      manager.dispose();
    }
    for (const home of homes.splice(0)) {
      home.cleanup();
    }
  });

  after(async () => {
    await sshd?.stop();
  });

  function setup(knownHosts: (server: SshdContainer) => string): {
    connections: ConnectionManager;
    prompt: ScriptedPrompt;
  } {
    assert.ok(sshd && key, 'The test SSH server did not start.');
    const server = sshd;
    const home = new TestHome();
    homes.push(home);
    const file = home.writeKey('id_ed25519', key.content);
    home.writeConfig([{ alias: 'test', port: server.clientConfig.port, identityFiles: [file] }]);
    home.writeKnownHosts(knownHosts(server));
    const prompt = new ScriptedPrompt([passphrase]);
    const connections = new ConnectionManager({
      ssh2: () => ssh2,
      environment: () => home.environment(),
      prompt: prompt.prompt,
      deriveKey: workerKeyDerivation(workerFile),
      watcher: nodeFileWatcher,
    });
    managers.push(connections);
    return { connections, prompt };
  }

  it('connects with a passphrase-protected key and opens SFTP', async () => {
    const { connections, prompt } = setup((server) =>
      knownHostsLine(server.clientConfig.port, server.hostKeyLines['ecdsa-sha2-nistp256']),
    );

    const home = await connections.run(
      { server: sftpServer('a', 'test'), configFile: undefined },
      (target) => target.realpath('.'),
    );

    assert.equal(home, '/home/deploy');
    assert.equal(prompt.requests.length, 1);
    assert.equal(connections.status('a'), 'connected');
  });

  it('rejects a host that is not in known_hosts', async () => {
    const { connections, prompt } = setup(() => '');

    await assert.rejects(
      connections.run({ server: sftpServer('a', 'test'), configFile: undefined }, (target) =>
        target.realpath('.'),
      ),
      (error: unknown) => error instanceof HostKeyRejectedError && error.problem === 'unknown',
    );
    assert.equal(prompt.requests.length, 0);
  });
});
