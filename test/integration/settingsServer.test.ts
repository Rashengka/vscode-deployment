/**
 * The server operations of the settings panel (Autodetect, the remote folder picker and Verify
 * Mapping) through the settings controller and a real connection manager, against a local
 * OpenSSH server in Docker.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import type { DeploymentConfig, SftpServer } from '../../src/config/model';
import { DeploymentLog } from '../../src/log/deploymentLog';
import { SettingsController, type SettingsHost } from '../../src/settings/controller';
import type { SftpDraft } from '../../src/settings/draft';
import { MAX_REMOTE_ENTRIES, type HostMessage } from '../../src/settings/protocol';
import { draftFromServer } from '../../src/settings/save';
import { UnsavedServerSession } from '../../src/settings/testUnsavedServer';
import { ConnectionManager, type Ssh2Module } from '../../src/ssh/connectionManager';
import { nodeFileWatcher } from '../../src/ssh/fileWatcher';
import { workerKeyDerivation } from '../../src/ssh/keyDerivation';
import { ScriptedPrompt, TestHome, knownHostsLine, sftpServer } from '../support/connectionFixture';
import { startSshd, type SshdContainer } from '../support/sshd';

const PROJECT = '/var/www/app';
const PAYLOAD = '<img src=x onerror=alert(1)>';
const PROJECT_FILES = Array.from({ length: 30 }, (_, i) => `src/file${i}.php`);

describe('settings panel server operations against a local OpenSSH server', () => {
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
    // The deployed project, a symbolic link out of the home directory, a folder with more
    // entries than the picker lists, and a folder named like an HTML element.
    await sshd.exec(
      [
        'set -eu',
        'cd /home/deploy',
        'mkdir -p www/app/src big',
        'for i in $(seq 0 29); do echo x > "www/app/src/file$i.php"; done',
        'ln -s /etc current',
        'i=0; while [ "$i" -lt 1100 ]; do : > "big/entry$i"; i=$((i + 1)); done',
        'mkdir -p "$1"',
        'mkdir -p locked/src && for i in $(seq 0 29); do : > "locked/src/file$i.php"; done',
        'chown -R deploy:deploy /home/deploy',
        'chmod 000 locked',
      ].join('\n'),
      PAYLOAD,
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

  interface Panel {
    readonly controller: SettingsController;
    readonly posted: HostMessage[];
    readonly connections: ConnectionManager;
    last<T extends HostMessage['type']>(type: T): Extract<HostMessage, { type: T }>;
  }

  async function panel(stored: SftpServer): Promise<Panel> {
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
    const posted: HostMessage[] = [];
    const config: DeploymentConfig = { version: 1, projectPath: PROJECT, servers: [stored] };
    const sink = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const host: SettingsHost = {
      folderName: 'app',
      platform: 'linux',
      log: new DeploymentLog(sink),
      post: (message) => {
        posted.push(message);
      },
      load: () => Promise.resolve({ status: 'ok', dir: '/config', config, migratedFrom: null }),
      projectPath: () => Promise.resolve(PROJECT),
      save: () => Promise.reject(new Error('not saved in this test')),
      listAliases: () => Promise.resolve(['test']),
      pickPath: () => Promise.resolve(undefined),
      testConnection: () => Promise.resolve(undefined),
      disconnect: () => undefined,
      onSaved: () => undefined,
      pickProjectPath: () => Promise.resolve(undefined),
      openSession: (unsaved) =>
        new UnsavedServerSession(connections, {
          key: `file:///var/www/app\n${unsaved.id}`,
          server: unsaved,
          configFile: undefined,
        }),
      listProjectFiles: () =>
        Promise.resolve({ files: PROJECT_FILES, source: 'git', truncated: false }),
      random: (max) => Math.floor(Math.random() * max),
    };
    const controller = new SettingsController(host);
    await controller.handle({ type: 'ready' });
    return {
      controller,
      posted,
      connections,
      last(type) {
        const found = posted.filter((message) => message.type === type).at(-1);
        if (found === undefined) {
          throw new Error(`no ${type} message was posted`);
        }
        return found as never;
      },
    };
  }

  function draftOf(stored: SftpServer): SftpDraft {
    const draft = draftFromServer(stored);
    if (draft.type !== 'sftp') {
      throw new Error('expected an SFTP draft');
    }
    return draft;
  }

  it('Autodetect sets the root path to the home directory of the user', async () => {
    const stored = sftpServer('a', 'test', { rootPath: '/var/www/app' });
    const p = await panel(stored);

    await p.controller.handle({
      type: 'autodetectRoot',
      server: { ...draftOf(stored), rootPath: '' },
    });

    expect(p.last('picked')).toEqual({
      type: 'picked',
      id: 'a',
      field: 'rootPath',
      path: '/home/deploy',
    });
    expect(p.last('taskStatus')).toMatchObject({ task: 'autodetect', state: 'connected' });
    // The connection with the unsaved settings is closed afterwards.
    expect(p.connections.activeServerIds()).toEqual([]);
  });

  it('lists the root path, shows a symbolic link without opening it and stays below the root', async () => {
    const stored = sftpServer('a', 'test', { rootPath: '/home/deploy' });
    const p = await panel(stored);

    await p.controller.handle({
      type: 'browseRemote',
      server: draftOf(stored),
      purpose: 'mapping',
      index: 0,
    });
    const root = p.last('remoteListing');
    expect(root.base).toBe('/home/deploy');
    const kinds = new Map(root.entries.map((entry) => [entry.name, entry.kind]));
    expect(kinds.get('www')).toBe('directory');
    expect(kinds.get('current')).toBe('symlink');
    expect(kinds.get(PAYLOAD)).toBe('directory');
    expect(root.entries.find((entry) => entry.name === PAYLOAD)?.label).toBe(PAYLOAD);

    await p.controller.handle({ type: 'remoteList', session: root.session, path: 'www' });
    expect(p.last('remoteListing')).toMatchObject({ path: 'www' });
    expect(p.last('remoteListing').entries.map((entry) => entry.name)).toEqual(['app']);
    await p.controller.handle({ type: 'remoteList', session: root.session, path: 'www/app' });
    expect(p.last('remoteListing').entries.map((entry) => entry.name)).toEqual(['src']);

    const listings = p.posted.filter((message) => message.type === 'remoteListing').length;
    for (const path of ['current', '..', 'www/../..']) {
      await p.controller.handle({ type: 'remoteList', session: root.session, path });
      expect(p.last('remoteError')).toMatchObject({
        path,
        message: 'This folder cannot be opened.',
      });
    }
    expect(p.posted.filter((message) => message.type === 'remoteListing')).toHaveLength(listings);

    expect(p.connections.activeServerIds()).toHaveLength(1);
    await p.controller.handle({ type: 'remoteClose' });
    expect(p.connections.activeServerIds()).toEqual([]);
  });

  it(`lists at most ${MAX_REMOTE_ENTRIES} entries of a folder and says that more exist`, async () => {
    const stored = sftpServer('a', 'test', { rootPath: '/home/deploy' });
    const p = await panel(stored);
    await p.controller.handle({
      type: 'browseRemote',
      server: draftOf(stored),
      purpose: 'mapping',
      index: 0,
    });
    const { session } = p.last('remoteListing');

    await p.controller.handle({ type: 'remoteList', session, path: 'big' });

    const big = p.last('remoteListing');
    expect(big.path).toBe('big');
    expect(big.entries).toHaveLength(MAX_REMOTE_ENTRIES);
    expect(big.truncated).toBe(true);
    await p.controller.handle({ type: 'remoteClose' });
  });

  it('Verify Mapping finds 20 of 20 files of a correct mapping', async () => {
    const stored = sftpServer('a', 'test', {
      rootPath: '/home/deploy',
      mappings: [{ localPath: '.', deploymentPath: 'www/app' }],
    });
    const p = await panel(stored);

    await p.controller.handle({ type: 'verifyMapping', server: draftOf(stored) });

    const [check] = p.last('verifyResult').checks;
    expect(check).toMatchObject({
      checked: 20,
      found: 20,
      verdict: 'correct',
      text: '20/20 files found – mapping looks correct',
      missing: [],
    });
    expect(p.connections.activeServerIds()).toEqual([]);
  });

  it('Verify Mapping finds 0 of 20 files of a wrong mapping and lists them', async () => {
    const stored = sftpServer('a', 'test', {
      rootPath: '/home/deploy',
      mappings: [{ localPath: '.', deploymentPath: 'www/wrong' }],
    });
    const p = await panel(stored);

    await p.controller.handle({ type: 'verifyMapping', server: draftOf(stored) });

    const [check] = p.last('verifyResult').checks;
    expect(check).toMatchObject({
      checked: 20,
      found: 0,
      verdict: 'wrong',
      text: '0/20 files found – mapping is probably wrong',
    });
    expect(check?.missing).toHaveLength(20);
    expect(check?.missing.every((file) => PROJECT_FILES.includes(file))).toBe(true);
  });

  it('Verify Mapping reports files the server refuses to look up, and is not green', async () => {
    const stored = sftpServer('a', 'test', {
      rootPath: '/home/deploy',
      mappings: [{ localPath: '.', deploymentPath: 'locked' }],
    });
    const p = await panel(stored);

    await p.controller.handle({ type: 'verifyMapping', server: draftOf(stored) });

    const [check] = p.last('verifyResult').checks;
    expect(check).toMatchObject({ checked: 0, found: 0, verdict: 'unchecked' });
    expect(check?.unchecked).toHaveLength(20);
    expect(p.last('taskStatus')).toMatchObject({ task: 'verify', state: 'failed' });
  });

  it('Verify Mapping of a wrong mapping is not green', async () => {
    const stored = sftpServer('a', 'test', {
      rootPath: '/home/deploy',
      mappings: [{ localPath: '.', deploymentPath: 'www/wrong' }],
    });
    const p = await panel(stored);
    await p.controller.handle({ type: 'verifyMapping', server: draftOf(stored) });
    expect(p.last('taskStatus')).toMatchObject({
      task: 'verify',
      state: 'failed',
      text: '0/20 files found.',
    });
  });
});
