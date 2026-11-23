/**
 * Compare with Deployed Version through a real connection manager and SftpTarget, against a
 * local OpenSSH server in Docker: what is read from the server, and what is refused.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { runCompare, type CompareHost, type OpenedDocument } from '../../src/compare/compareFlow';
import { MAX_COMPARE_BYTES, fetchDeployedVersion } from '../../src/compare/fetch';
import { DeploymentLog } from '../../src/log/deploymentLog';
import { ConnectionManager, type Ssh2Module } from '../../src/ssh/connectionManager';
import { nodeFileWatcher } from '../../src/ssh/fileWatcher';
import { workerKeyDerivation } from '../../src/ssh/keyDerivation';
import { connectionKey, type SftpServerChoice } from '../../src/ui/serverChoices';
import { ScriptedPrompt, TestHome, knownHostsLine, sftpServer } from '../support/connectionFixture';
import { startSshd, type SshdContainer } from '../support/sshd';

const TEXT = '<?php\necho "Příliš žluťoučký kůň ↔";\n';
const APP = '/home/deploy/www/app';

describe('Compare with Deployed Version against a local OpenSSH server', () => {
  let sshd: SshdContainer | undefined;
  let ssh2: Ssh2Module;
  let workerFile: string;
  const homes: TestHome[] = [];
  const managers: ConnectionManager[] = [];

  beforeAll(async () => {
    const dist = join(inject('unpackedExtension'), 'dist');
    ssh2 = createRequire(join(dist, 'ssh2.js'))(join(dist, 'ssh2.js')) as Ssh2Module;
    workerFile = join(dist, 'kdfWorker.js');
    sshd = await startSshd();
    await sshd.exec(
      [
        'set -eu',
        `mkdir -p ${APP}/src ${APP}/folder`,
        `printf '%s' "$1" > ${APP}/src/index.php`,
        `printf 'PNG\\000\\001\\002' > ${APP}/logo.png`,
        // A text file one byte over the limit, whatever the server would report as its size.
        `head -c $(( ${MAX_COMPARE_BYTES} + 1 )) /dev/zero | tr '\\000' a > ${APP}/big.txt`,
        `ln -s /etc/passwd ${APP}/link.php`,
        `printf 'secret' > ${APP}/locked.php`,
        'chown -R deploy:deploy /home/deploy',
        `chmod 000 ${APP}/locked.php`,
      ].join('\n'),
      TEXT,
    );
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

  function manager(): ConnectionManager {
    const home = new TestHome();
    homes.push(home);
    const key = home.writeKey('id_ed25519', Buffer.from(server().clientConfig.privateKey));
    home.writeConfig([{ alias: 'test', port: server().clientConfig.port, identityFiles: [key] }]);
    home.writeKnownHosts(
      knownHostsLine(server().clientConfig.port, server().hostKeyLines['ssh-ed25519']),
    );
    const connections = new ConnectionManager({
      ssh2: () => ssh2,
      environment: () => home.environment(),
      prompt: new ScriptedPrompt([]).prompt,
      deriveKey: workerKeyDerivation(workerFile),
      watcher: nodeFileWatcher,
    });
    managers.push(connections);
    return connections;
  }

  const stored = sftpServer('a', 'test', {
    name: 'Test Server',
    mappings: [{ localPath: '.', deploymentPath: 'www/app' }],
  });
  const reference = { server: stored, configFile: undefined };

  it('reads the deployed version of a text file byte for byte', async () => {
    const version = await manager().run(reference, (target) =>
      fetchDeployedVersion(target, `${APP}/src/index.php`),
    );
    expect(version.kind).toBe('text');
    expect(version.kind === 'text' && version.content.toString('utf8')).toBe(TEXT);
    expect(version.kind === 'text' && version.stat.size).toBe(Buffer.byteLength(TEXT));
  });

  it('reads the current content after another process changed the file', async () => {
    const connections = manager();
    const read = (): Promise<string> =>
      connections.run(reference, async (target) => {
        const version = await fetchDeployedVersion(target, `${APP}/src/changing.txt`);
        return version.kind === 'text' ? version.content.toString('utf8') : version.kind;
      });
    await server().exec(`printf 'one' > ${APP}/src/changing.txt`);
    expect(await read()).toBe('one');
    await server().exec(`printf 'two, longer' > ${APP}/src/changing.txt`);
    expect(await read()).toBe('two, longer');
  });

  it('reports a missing file, a symbolic link, a folder and a binary file without content', async () => {
    const connections = manager();
    const fetch = (path: string): ReturnType<typeof fetchDeployedVersion> =>
      connections.run(reference, (target) => fetchDeployedVersion(target, path));
    expect(await fetch(`${APP}/missing.php`)).toEqual({ kind: 'missing' });
    expect(await fetch(`${APP}/link.php`)).toEqual({ kind: 'symlink' });
    expect(await fetch(`${APP}/folder`)).toEqual({ kind: 'notFile', type: 'directory' });
    expect(await fetch(`${APP}/logo.png`)).toEqual({ kind: 'binary', size: 6 });
  });

  it('stops reading a file over the limit with an error, not a crash, and stays connected', async () => {
    const connections = manager();
    const version = await connections.run(reference, (target) =>
      fetchDeployedVersion(target, `${APP}/big.txt`),
    );
    expect(version).toEqual({ kind: 'tooLarge', maxBytes: MAX_COMPARE_BYTES });
    // The connection is still usable afterwards.
    await expect(connections.run(reference, (target) => target.realpath('.'))).resolves.toBe(
      '/home/deploy',
    );
  });

  it('passes on a read the server refuses as an SFTP status error', async () => {
    const failure = await manager()
      .run(reference, (target) => fetchDeployedVersion(target, `${APP}/locked.php`))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error & { code?: unknown }).code).toBe(3);
  });

  it('opens the diff with the deployed version through the whole flow', async () => {
    const connections = manager();
    const opened: { document: OpenedDocument; title: string }[] = [];
    const messages: string[] = [];
    const sink = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const host: CompareHost = {
      connections,
      log: new DeploymentLog(sink),
      withProgress: (_title, work) => work(() => undefined),
      showInformation: (message) => messages.push(message),
      showWarning: (message) => messages.push(message),
      showError: (message) => messages.push(message),
      openDiff: (document, title) => {
        opened.push({ document, title });
        return Promise.resolve();
      },
    };
    const choice: SftpServerChoice = {
      key: connectionKey('file:///var/www/app', 'a'),
      server: stored,
      folderName: 'app',
      configFile: '/config.json',
    };
    const request = { choice, projectDir: '/var/www/app', platform: 'linux' as const };

    const result = await runCompare(host, {
      ...request,
      localFile: '/var/www/app/src/index.php',
      displayName: 'index.php',
    });
    expect(result).toEqual({
      outcome: 'opened',
      title: 'index.php (Test Server) ↔ Local',
      remotePath: `${APP}/src/index.php`,
    });
    expect(opened[0]?.document.content.toString('utf8')).toBe(TEXT);

    const missing = await runCompare(host, {
      ...request,
      localFile: '/var/www/app/gone.php',
      displayName: 'gone.php',
    });
    expect(missing.outcome).toBe('missing');
    expect(messages).toEqual(['File does not exist on Test Server']);
  });
});
