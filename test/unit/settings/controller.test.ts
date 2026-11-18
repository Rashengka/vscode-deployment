import { describe, expect, it } from 'vitest';
import type { DeploymentConfig, SftpServer } from '../../../src/config/model';
import { ConfigChangedError, UnsafeConfigError, type LoadResult } from '../../../src/config/store';
import { DeploymentLog, type LogSink } from '../../../src/log/deploymentLog';
import { SettingsController, type SettingsHost } from '../../../src/settings/controller';
import { newServerDraft, type ServerDraft, type SftpDraft } from '../../../src/settings/draft';
import type { HostMessage } from '../../../src/settings/protocol';
import { draftsFromConfig } from '../../../src/settings/save';
import { SshConfigError } from '../../../src/ssh/sshConfig';
import type { TestConnectionResult } from '../../../src/ui/testConnectionFlow';
import { PROJECT, inplaceServer, sftpServer } from '../config/fixtures';

class Lines implements LogSink {
  readonly lines: string[] = [];
  info(message: string): void {
    this.lines.push(message);
  }
  warn(message: string): void {
    this.lines.push(message);
  }
  error(message: string): void {
    this.lines.push(message);
  }
}

interface Fake {
  readonly host: SettingsHost;
  readonly posted: HostMessage[];
  readonly saved: { config: DeploymentConfig; expected: DeploymentConfig | null }[];
  readonly disconnected: string[];
  readonly tested: SftpServer[];
  readonly log: Lines;
  disk: LoadResult;
  saveError: Error | undefined;
  savedCount: number;
  last<T extends HostMessage['type']>(type: T): Extract<HostMessage, { type: T }>;
}

function config(...servers: DeploymentConfig['servers']): DeploymentConfig {
  return { version: 1, projectPath: PROJECT, servers };
}

function fake(initial: LoadResult, options: { aliases?: () => Promise<string[]> } = {}): Fake {
  const log = new Lines();
  const state: Fake = {
    posted: [],
    saved: [],
    disconnected: [],
    tested: [],
    log,
    disk: initial,
    saveError: undefined,
    savedCount: 0,
    last(type) {
      const found = state.posted.filter((message) => message.type === type).at(-1);
      if (found === undefined) {
        throw new Error(`no ${type} message was posted`);
      }
      return found as never;
    },
    host: undefined as unknown as SettingsHost,
  };
  const host: SettingsHost = {
    folderName: 'app',
    platform: 'linux',
    log: new DeploymentLog(log),
    post: (message) => {
      state.posted.push(message);
    },
    load: () => Promise.resolve(state.disk),
    projectPath: () => Promise.resolve(PROJECT),
    save: (saved, expected) => {
      if (state.saveError !== undefined) {
        return Promise.reject(state.saveError);
      }
      state.saved.push({ config: saved, expected });
      state.disk = { status: 'ok', dir: '/config', config: saved, migratedFrom: null };
      return Promise.resolve();
    },
    listAliases: options.aliases ?? (() => Promise.resolve(['app', 'staging'])),
    pickPath: (field) =>
      Promise.resolve(field === 'folder' ? '/var/www/app' : '/home/deploy/.ssh/id_ed25519'),
    testConnection: (server): Promise<TestConnectionResult | undefined> => {
      state.tested.push(server);
      return Promise.resolve({
        key: server.id,
        serverId: server.id,
        serverName: server.name,
        user: 'deploy',
        address: 'deploy@example.com:22',
        home: '/home/deploy',
        banner: undefined,
      });
    },
    disconnect: (id) => {
      state.disconnected.push(id);
    },
    onSaved: () => {
      state.savedCount += 1;
    },
  };
  return Object.assign(state, { host });
}

const okResult = (value: DeploymentConfig): LoadResult => ({
  status: 'ok',
  dir: '/config',
  config: value,
  migratedFrom: null,
});

async function opened(
  initial: LoadResult,
): Promise<{ fake: Fake; controller: SettingsController }> {
  const f = fake(initial);
  const controller = new SettingsController(f.host);
  await controller.handle({ type: 'ready' });
  return { fake: f, controller };
}

describe('SettingsController', () => {
  it('sends the saved servers and the SSH config hosts when the webview is ready', async () => {
    const stored = config(sftpServer(), inplaceServer());
    const { fake: f } = await opened(okResult(stored));
    expect(f.last('state')).toEqual({
      type: 'state',
      folderName: 'app',
      saved: draftsFromConfig(stored),
      draft: draftsFromConfig(stored),
      aliases: ['app', 'staging'],
      aliasProblem: null,
      problem: null,
      changedOnDisk: false,
      notice: null,
      errors: [],
    });
  });

  it('starts with no servers when there is no configuration yet', async () => {
    const { fake: f } = await opened({ status: 'missing', dir: '/config' });
    expect(f.last('state')).toMatchObject({ saved: [], draft: [], problem: null });
  });

  it('refuses to edit an unsafe or invalid configuration', async () => {
    const unsafe = await opened({ status: 'unsafe', problem: '/config is writable by others' });
    expect(unsafe.fake.last('state').problem).toContain('/config is writable by others');
    const invalid = await opened({
      status: 'invalid',
      dir: '/config',
      errors: ['version: must be 1'],
    });
    expect(invalid.fake.last('state').problem).toContain('version: must be 1');

    await invalid.controller.handle({ type: 'save', servers: [] });
    expect(invalid.fake.saved).toEqual([]);
  });

  it('reports a broken SSH config, sanitized, and still offers manual connections', async () => {
    const f = fake(okResult(config()), {
      aliases: () =>
        Promise.reject(
          new SshConfigError('Bad\u001b[2J line', undefined, '/home/deploy/.ssh/config', 3),
        ),
    });
    await new SettingsController(f.host).handle({ type: 'ready' });
    const state = f.last('state');
    expect(state.aliases).toEqual([]);
    expect(state.aliasProblem).toContain('Bad\\x1b[2J line');
    expect(state.aliasProblem).not.toContain('\u001b');
  });

  it('drops and logs a message that does not match the schema, without its content', async () => {
    const { fake: f } = await opened(okResult(config()));
    const before = f.posted.length;
    await new SettingsController(f.host).handle({ type: 'save', servers: [{ secret: 'x' }] });
    await new SettingsController(f.host).handle({ type: 'evaluate', code: 'alert(1)' });
    expect(f.saved).toEqual([]);
    expect(f.posted.length).toBe(before);
    expect(f.log.lines).toEqual([
      'Settings: ignored an invalid "save" message from the settings panel',
      'Settings: ignored an unknown message from the settings panel',
    ]);
    expect(f.log.lines.join('\n')).not.toMatch(/secret|alert/);
  });

  it('saves a new server through the store with the loaded content as the expected one', async () => {
    const { fake: f, controller } = await opened({ status: 'missing', dir: '/config' });
    const server: ServerDraft = {
      ...(newServerDraft('sftp', 'n1', []) as SftpDraft),
      sshConfigHost: 'app',
      rootPath: '/home/deploy',
    };
    await controller.handle({ type: 'draft', servers: [server] });
    expect(controller.isDirty()).toBe(true);

    await controller.handle({ type: 'save', servers: [server] });
    expect(f.saved).toHaveLength(1);
    expect(f.saved[0]?.expected).toBeNull();
    expect(f.saved[0]?.config.servers[0]).toMatchObject({ id: 'n1', default: true, mappings: [] });
    expect(f.last('state')).toMatchObject({ notice: 'Saved.', saved: [server], draft: [server] });
    expect(controller.isDirty()).toBe(false);
    expect(f.savedCount).toBe(1);
  });

  it('keeps the form and reports the errors when the drafts are not valid', async () => {
    const { fake: f, controller } = await opened(okResult(config(sftpServer())));
    const [draft] = draftsFromConfig(config(sftpServer())) as [SftpDraft];
    await controller.handle({ type: 'save', servers: [{ ...draft, rootPath: 'relative' }] });
    expect(f.saved).toEqual([]);
    expect(f.last('errors').errors).toEqual([
      expect.objectContaining({ serverId: 'a1b2c3', field: 'rootPath' }),
    ]);
  });

  it('never overwrites a configuration that changed on disk; Reload shows it', async () => {
    const stored = config(sftpServer());
    const { fake: f, controller } = await opened(okResult(stored));
    const [draft] = draftsFromConfig(stored) as [SftpDraft];
    f.saveError = new ConfigChangedError();
    f.disk = okResult(config(sftpServer({ name: 'Changed elsewhere' })));

    await controller.handle({ type: 'save', servers: [{ ...draft, name: 'Mine' }] });
    expect(f.saved).toEqual([]);
    expect(f.posted).toContainEqual({ type: 'changedOnDisk' });
    expect(f.last('errors').errors[0]?.message).toContain('changed outside this panel');
    expect(controller.isDirty()).toBe(true);

    await controller.handle({ type: 'reload' });
    expect(f.last('state')).toMatchObject({
      changedOnDisk: false,
      saved: [expect.objectContaining({ name: 'Changed elsewhere' })],
      draft: [expect.objectContaining({ name: 'Changed elsewhere' })],
    });
    expect(controller.isDirty()).toBe(false);
  });

  it('reports other store errors without saving', async () => {
    const { fake: f, controller } = await opened(okResult(config()));
    f.saveError = new UnsafeConfigError('/config is a symbolic link');
    await controller.handle({ type: 'save', servers: [] });
    expect(f.last('errors').errors[0]?.message).toContain('/config is a symbolic link');
  });

  it('shows a banner when the file changes on disk, but not after its own save', async () => {
    const stored = config(sftpServer());
    const { fake: f, controller } = await opened(okResult(stored));
    await controller.checkDisk();
    expect(f.posted).not.toContainEqual({ type: 'changedOnDisk' });

    await controller.handle({ type: 'save', servers: draftsFromConfig(stored) });
    await controller.checkDisk();
    expect(f.posted).not.toContainEqual({ type: 'changedOnDisk' });

    f.disk = { status: 'missing', dir: '/config' };
    await controller.checkDisk();
    expect(f.posted).toContainEqual({ type: 'changedOnDisk' });
  });

  it('closes the connection of a deleted server after saving', async () => {
    const stored = config(sftpServer(), inplaceServer());
    const { fake: f, controller } = await opened(okResult(stored));
    const [, inplace] = draftsFromConfig(stored);
    await controller.handle({ type: 'save', servers: inplace === undefined ? [] : [inplace] });
    expect(f.saved[0]?.config.servers.map((server) => server.id)).toEqual(['d4e5f6']);
    expect(f.disconnected).toEqual(['a1b2c3']);
  });

  it('sets the default server', async () => {
    const stored = config(sftpServer(), inplaceServer());
    const { fake: f, controller } = await opened(okResult(stored));
    const drafts = draftsFromConfig(stored).map((server) => ({
      ...server,
      default: server.id === 'd4e5f6',
    }));
    await controller.handle({ type: 'save', servers: drafts });
    expect(f.saved[0]?.config.servers.map((server) => server.default)).toEqual([false, true]);
  });

  it('keeps unsaved edits for a webview that is loaded again', async () => {
    const stored = config(sftpServer());
    const { fake: f, controller } = await opened(okResult(stored));
    const [draft] = draftsFromConfig(stored) as [SftpDraft];
    const edited = [{ ...draft, name: 'Edited' }];
    await controller.handle({ type: 'draft', servers: edited });
    await controller.handle({ type: 'ready' });
    expect(f.last('state')).toMatchObject({ saved: [draft], draft: edited });
    const snapshot = controller.snapshot();
    expect(snapshot?.draft).toEqual(edited);

    const restored = new SettingsController(f.host, snapshot);
    await restored.handle({ type: 'ready' });
    expect(f.last('state').draft).toEqual(edited);
    expect(restored.isDirty()).toBe(true);
  });

  it('keeps what it loaded when reopened, so a change made meanwhile is not overwritten', async () => {
    const stored = config(sftpServer());
    const { fake: f, controller } = await opened(okResult(stored));
    const [draft] = draftsFromConfig(stored) as [SftpDraft];
    const edited = [{ ...draft, name: 'Mine' }];
    await controller.handle({ type: 'draft', servers: edited });
    const snapshot = controller.snapshot();
    // Another window saves while the "Discard?" question is open.
    f.disk = okResult(config(sftpServer({ name: 'Theirs' })));

    const reopened = new SettingsController(f.host, snapshot);
    await reopened.handle({ type: 'ready' });
    expect(f.last('state')).toMatchObject({ changedOnDisk: true, draft: edited });
    await reopened.handle({ type: 'save', servers: edited });
    expect(f.saved).toEqual([]);
    expect(f.last('errors').errors[0]?.message).toContain('changed outside this panel');
  });

  it('keeps the changed-on-disk state over a reopen', async () => {
    const stored = config(sftpServer());
    const { fake: f, controller } = await opened(okResult(stored));
    const [draft] = draftsFromConfig(stored) as [SftpDraft];
    await controller.handle({ type: 'draft', servers: [{ ...draft, name: 'Mine' }] });
    f.disk = okResult(config(sftpServer({ name: 'Theirs' })));
    await controller.checkDisk();
    // The file is changed back: what the panel loaded matches again, but it was told.
    f.disk = okResult(stored);
    const reopened = new SettingsController(f.host, controller.snapshot());
    await reopened.handle({ type: 'ready' });
    expect(f.last('state').changedOnDisk).toBe(true);
  });

  it('notices a change on disk when the webview is loaded again', async () => {
    const stored = config(sftpServer());
    const { fake: f, controller } = await opened(okResult(stored));
    f.disk = okResult(config());
    await controller.handle({ type: 'ready' });
    expect(f.last('state').changedOnDisk).toBe(true);
  });

  it('keeps a picked path as an unsaved edit of the host', async () => {
    const stored = config(sftpServer());
    const { fake: f, controller } = await opened(okResult(stored));
    await controller.handle({ type: 'pickPath', id: 'a1b2c3', field: 'identityFile' });
    expect(controller.isDirty()).toBe(true);
    await controller.handle({ type: 'ready' });
    expect(f.last('state').draft[0]).toMatchObject({
      identityFile: '/home/deploy/.ssh/id_ed25519',
    });
    expect(controller.snapshot()?.draft[0]).toMatchObject({
      identityFile: '/home/deploy/.ssh/id_ed25519',
    });
  });

  it('finishes a save after the panel was closed without posting or asking', async () => {
    const stored = config(sftpServer());
    const f = fake(okResult(stored));
    let finish: () => void = () => undefined;
    const host: SettingsHost = {
      ...f.host,
      save: (saved) =>
        new Promise((resolve) => {
          finish = () => {
            f.disk = okResult(saved);
            resolve();
          };
        }),
    };
    const controller = new SettingsController(host);
    await controller.handle({ type: 'ready' });
    const [draft] = draftsFromConfig(stored) as [SftpDraft];
    const saving = controller.handle({ type: 'save', servers: [{ ...draft, name: 'Live' }] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const before = f.posted.length;
    controller.dispose();
    finish();
    await saving;
    await controller.settled();
    expect(f.posted.length).toBe(before);
    expect(controller.snapshot()).toBeNull();
    expect(f.disk).toMatchObject({ config: { servers: [{ name: 'Live' }] } });
  });

  it('reports a file system error of the save with its code', async () => {
    const { fake: f, controller } = await opened(okResult(config()));
    f.saveError = Object.assign(new Error('EACCES: permission denied, open /config/x'), {
      code: 'EACCES',
    });
    await controller.handle({ type: 'save', servers: [] });
    expect(f.last('errors').errors).toEqual([
      { serverId: null, field: null, message: 'The configuration could not be saved (EACCES).' },
    ]);
  });

  it('still sends the state when listing the SSH config hosts fails unexpectedly', async () => {
    const f = fake(okResult(config()), {
      aliases: () => Promise.reject(new TypeError('boom /home/deploy/secret')),
    });
    await new SettingsController(f.host).handle({ type: 'ready' });
    const state = f.last('state');
    expect(state.aliases).toEqual([]);
    expect(state.aliasProblem).toBe(
      'The SSH config hosts could not be listed. The details are in the Deployment log.',
    );
    expect(f.log.lines.some((line) => line.includes('boom'))).toBe(true);
  });

  it('runs one Test Connection per panel at a time and logs the dropped one', async () => {
    const stored = config(sftpServer(), sftpServer({ id: 'other', name: 'Other', default: false }));
    const f = fake(okResult(stored));
    let finish: () => void = () => undefined;
    const host: SettingsHost = {
      ...f.host,
      testConnection: (server) => {
        f.tested.push(server);
        return new Promise((resolve) => {
          finish = () => {
            resolve(undefined);
          };
        });
      },
    };
    const controller = new SettingsController(host);
    await controller.handle({ type: 'ready' });
    const [one, two] = draftsFromConfig(stored) as [SftpDraft, SftpDraft];
    const first = controller.handle({ type: 'testConnection', server: one });
    await controller.handle({ type: 'testConnection', server: two });
    expect(f.tested.map((server) => server.id)).toEqual(['a1b2c3']);
    expect(f.log.lines).toContain(
      'Settings: ignored a "testConnection" message while Test Connection is running',
    );
    expect(
      f.posted.filter((message) => message.type === 'testStatus' && message.id === 'other'),
    ).toEqual([
      {
        type: 'testStatus',
        id: 'other',
        state: 'failed',
        text: 'Another Test Connection is running.',
      },
    ]);
    finish();
    await first;
  });

  it('drops a message that is too large before looking at it', async () => {
    const { fake: f, controller } = await opened(okResult(config()));
    const huge = { type: 'draft', servers: [], padding: 'x'.repeat(2_000_000) };
    await controller.handle(huge);
    expect(f.log.lines.at(-1)).toBe(
      'Settings: ignored a too large message from the settings panel',
    );
  });

  it('ignores a second Save while one is running', async () => {
    const stored = config(sftpServer());
    const f = fake(okResult(stored));
    let finish: () => void = () => undefined;
    let saves = 0;
    const host: SettingsHost = {
      ...f.host,
      save: (saved) => {
        saves += 1;
        return new Promise((resolve) => {
          finish = () => {
            f.disk = okResult(saved);
            resolve();
          };
        });
      },
    };
    const controller = new SettingsController(host);
    await controller.handle({ type: 'ready' });
    const servers = draftsFromConfig(stored);
    const first = controller.handle({ type: 'save', servers });
    const second = controller.handle({ type: 'save', servers });
    await new Promise((resolve) => setTimeout(resolve, 0));
    finish();
    await Promise.all([first, second]);
    await controller.settled();
    expect(saves).toBe(1);
    expect(f.log.lines).toContain('Settings: ignored a "save" message while saving');
  });

  it('keeps the projectPath of the loaded configuration', async () => {
    const stored = config(sftpServer());
    const f = fake(okResult(stored));
    const host: SettingsHost = { ...f.host, projectPath: () => Promise.resolve('/var/www/other') };
    const controller = new SettingsController(host);
    await controller.handle({ type: 'ready' });
    await controller.handle({ type: 'save', servers: draftsFromConfig(stored) });
    expect(f.saved[0]?.config.projectPath).toBe(PROJECT);
  });

  it('answers a path picker request', async () => {
    const { fake: f, controller } = await opened(okResult(config()));
    await controller.handle({ type: 'pickPath', id: 'n1', field: 'identityFile' });
    expect(f.last('picked')).toEqual({
      type: 'picked',
      id: 'n1',
      field: 'identityFile',
      path: '/home/deploy/.ssh/id_ed25519',
    });
  });

  it('tests the connection with the unsaved form, through the extension host', async () => {
    const stored = config(sftpServer());
    const { fake: f, controller } = await opened(okResult(stored));
    const [draft] = draftsFromConfig(stored) as [SftpDraft];
    await controller.handle({ type: 'testConnection', server: { ...draft, user: 'other' } });
    expect(f.tested[0]?.connection.user).toBe('other');
    expect(f.tested[0]?.mappings).toEqual(sftpServer().mappings);
    expect(f.posted.filter((message) => message.type === 'testStatus')).toEqual([
      { type: 'testStatus', id: 'a1b2c3', state: 'running', text: 'Connecting…' },
      {
        type: 'testStatus',
        id: 'a1b2c3',
        state: 'connected',
        text: 'Connected as deploy. Home directory: /home/deploy',
      },
    ]);
  });

  it('does not test a form with errors', async () => {
    const { fake: f, controller } = await opened(okResult(config()));
    const draft = newServerDraft('sftp', 'n1', []) as SftpDraft;
    await controller.handle({ type: 'testConnection', server: draft });
    expect(f.tested).toEqual([]);
    expect(f.last('testStatus')).toMatchObject({ state: 'failed' });
    expect(f.last('errors').errors[0]).toMatchObject({ field: 'sshConfigHost' });
  });

  it('runs one Test Connection per server at a time', async () => {
    const stored = config(sftpServer());
    const f = fake(okResult(stored));
    let finish: (() => void) | undefined;
    const host: SettingsHost = {
      ...f.host,
      testConnection: (server) => {
        f.tested.push(server);
        return new Promise((resolve) => {
          finish = () => {
            resolve(undefined);
          };
        });
      },
    };
    const controller = new SettingsController(host);
    await controller.handle({ type: 'ready' });
    const [draft] = draftsFromConfig(stored) as [SftpDraft];
    const first = controller.handle({ type: 'testConnection', server: draft });
    await controller.handle({ type: 'testConnection', server: draft });
    expect(f.tested).toHaveLength(1);
    finish?.();
    await first;
    expect(f.last('testStatus')).toMatchObject({ state: 'failed' });
  });

  it('answers a save that fails unexpectedly', async () => {
    const { fake: f, controller } = await opened(okResult(config()));
    f.saveError = new TypeError('a bug');
    await expect(controller.handle({ type: 'save', servers: [] })).rejects.toThrow('a bug');
    expect(f.last('saveFailed').message).toContain('unexpected error');
  });

  it('says Saved when loading the file again after a successful save fails', async () => {
    const stored = config(sftpServer());
    const { fake: f } = await opened(okResult(stored));
    const host = f.host;
    let loads = 0;
    const failing = new SettingsController({
      ...host,
      load: () => {
        loads += 1;
        return loads === 1 ? Promise.resolve(f.disk) : Promise.reject(new Error('load failed'));
      },
    });
    await failing.handle({ type: 'ready' });
    const [draft] = draftsFromConfig(stored) as [SftpDraft];
    await failing.handle({ type: 'save', servers: [{ ...draft, name: 'Live' }] });
    expect(f.saved).toHaveLength(1);
    expect(f.last('state')).toMatchObject({
      notice: 'Saved.',
      saved: [expect.objectContaining({ name: 'Live' })],
    });
    expect(failing.isDirty()).toBe(false);
    expect(f.posted.some((message) => message.type === 'saveFailed')).toBe(false);
  });

  it('answers a save message that is too large', async () => {
    const { fake: f, controller } = await opened(okResult(config()));
    await controller.handle({ type: 'save', servers: [{ name: 'x'.repeat(2_000_000) }] });
    expect(f.saved).toEqual([]);
    expect(f.last('saveFailed').message).toBe('The settings are too large to save.');
  });

  it('takes over restored changes when it has none of its own', async () => {
    const stored = config(sftpServer());
    const { fake: f, controller } = await opened(okResult(stored));
    const [draft] = draftsFromConfig(stored) as [SftpDraft];
    const edited = [{ ...draft, name: 'Restored' }];
    const restored = {
      draft: edited,
      loaded: { kind: 'usable', config: stored } as const,
      changedOnDisk: false,
    };

    expect(await controller.restore(restored)).toBe(true);
    expect(controller.isDirty()).toBe(true);
    expect(f.last('state').draft).toEqual(edited);
  });

  it('keeps its own unsaved changes over restored ones', async () => {
    const stored = config(sftpServer());
    const { controller } = await opened(okResult(stored));
    const [draft] = draftsFromConfig(stored) as [SftpDraft];
    const own = [{ ...draft, name: 'Own' }];
    await controller.handle({ type: 'draft', servers: own });
    const restored = {
      draft: [{ ...draft, name: 'Restored' }],
      loaded: { kind: 'usable', config: stored } as const,
      changedOnDisk: false,
    };

    expect(await controller.restore(restored)).toBe(false);
    expect(controller.snapshot()?.draft).toEqual(own);
  });
});
