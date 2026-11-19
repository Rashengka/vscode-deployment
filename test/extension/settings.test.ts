import { strict as assert } from 'node:assert';
import { readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { DeploymentConfig } from '../../src/config/model';
import { loadConfig, saveConfig } from '../../src/config/store';
import { validateConfig } from '../../src/config/validate';
import type { InplaceDraft, ServerDraft, SftpDraft } from '../../src/settings/draft';
import type { HostMessage } from '../../src/settings/protocol';
import type { SettingsPanelHandle } from '../../src/webview/settingsPanel';
import { extensionUnderTest } from './extensionUnderTest';
import { storeOptions } from './support/instance';

const OPEN_SETTINGS_COMMAND = 'vscodeDeployment.openSettings';

interface ContributedCommand {
  readonly command: string;
  readonly title: string;
  readonly category?: string;
}

const SFTP: SftpDraft = {
  id: 'settings-sftp',
  type: 'sftp',
  name: 'Staging',
  default: true,
  mode: 'manual',
  sshConfigHost: '',
  host: 'example.com',
  port: '2222',
  user: 'deploy',
  identityFile: '/home/deploy/.ssh/id_ed25519',
  rootPath: '/home/deploy',
  keepAliveSeconds: '60',
  idleDisconnectMinutes: '15',
};

const INPLACE: InplaceDraft = {
  id: 'settings-inplace',
  type: 'inplace',
  name: 'Local',
  default: false,
  folder: '/var/www/app',
  webUrl: 'http://app.example.com/',
};

async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${what} did not happen within ${ms} ms`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function lastOf<T extends HostMessage['type']>(
  handle: SettingsPanelHandle,
  type: T,
): Extract<HostMessage, { type: T }> {
  const found = handle
    .posted()
    .filter((message) => message.type === type)
    .at(-1);
  assert.ok(found, `no ${type} message was sent to the webview`);
  return found as Extract<HostMessage, { type: T }>;
}

describe('Open Settings command and the settings panel', () => {
  let folder: vscode.WorkspaceFolder;
  let handle: SettingsPanelHandle;

  /** The configuration file of the workspace folder, and its content as loaded. */
  async function current(): Promise<{ file: string; config: DeploymentConfig | null }> {
    const result = await loadConfig(folder.uri.fsPath, storeOptions());
    assert.ok(result.status === 'ok' || result.status === 'missing', result.status);
    return {
      file: join(result.dir, 'config.json'),
      config: result.status === 'ok' ? result.config : null,
    };
  }

  async function removeConfig(): Promise<void> {
    const { file } = await current();
    rmSync(join(file, '..'), { recursive: true, force: true });
  }

  before(async () => {
    await extensionUnderTest().activate();
    const first = vscode.workspace.workspaceFolders?.[0];
    assert.ok(first, 'the test instance has no workspace folder');
    folder = first;
    // Earlier tests may have left a configuration; this one starts without.
    await removeConfig();
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await removeConfig();
  });

  it('is contributed with its title and category and registered', async () => {
    const packageJson = extensionUnderTest().packageJSON as {
      contributes: { commands: ContributedCommand[] };
    };
    assert.deepEqual(
      packageJson.contributes.commands.find((entry) => entry.command === OPEN_SETTINGS_COMMAND),
      { command: OPEN_SETTINGS_COMMAND, title: 'Open Settings', category: 'Deployment' },
    );
    const registered = await vscode.commands.getCommands(true);
    assert.ok(registered.includes(OPEN_SETTINGS_COMMAND));
  });

  it('opens a panel whose script runs under a strict Content Security Policy', async () => {
    const opened = await vscode.commands.executeCommand<SettingsPanelHandle | undefined>(
      OPEN_SETTINGS_COMMAND,
    );
    assert.ok(opened, 'the command did not open a panel');
    handle = opened;
    // The bundled script only runs when the CSP nonce and the resource root are right.
    await within(handle.whenReady(), 30_000, 'the webview script starting');

    const html = handle.html();
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html)?.[1];
    assert.ok(csp, 'the document has no CSP meta element');
    const directives = csp.split('; ');
    assert.equal(directives[0], "default-src 'none'");
    assert.ok(directives.includes("base-uri 'none'"));
    assert.ok(directives.includes("form-action 'none'"));
    const nonce = /script-src 'nonce-([A-Za-z0-9_-]+)'/.exec(csp)?.[1];
    assert.ok(nonce, 'scripts are not limited to a nonce');
    assert.ok(html.includes(`<script nonce="${nonce}" src="`));
    assert.ok(!/\son[a-z]+=/i.test(html), 'the document has an inline event handler');

    const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
    assert.ok(tabs.some((tab) => tab.label === `Deployment: ${folder.name}`));
    // Opening it again shows the same panel.
    const again = await vscode.commands.executeCommand<SettingsPanelHandle | undefined>(
      OPEN_SETTINGS_COMMAND,
    );
    assert.equal(again, handle);
  });

  it('starts with no servers and refuses a message that does not match the schema', async () => {
    await handle.receive({ type: 'ready' });
    assert.deepEqual(lastOf(handle, 'state').saved, []);

    await handle.receive({ type: 'save', servers: [{ ...SFTP, passphrase: 'x' }] });
    assert.equal((await current()).config, null, 'an invalid message was saved');
  });

  it('creates servers and writes a configuration that passes validation', async () => {
    await handle.receive({ type: 'save', servers: [SFTP, INPLACE] });

    const state = lastOf(handle, 'state');
    assert.equal(state.notice, 'Saved.');
    const { file, config } = await current();
    assert.ok(config, 'nothing was saved');
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    assert.ok(validateConfig(raw, { platform: process.platform }).ok);
    assert.deepEqual(raw, {
      version: 1,
      projectPath: realpathSync.native(folder.uri.fsPath),
      servers: [
        {
          id: 'settings-sftp',
          name: 'Staging',
          default: true,
          type: 'sftp',
          connection: {
            sshConfigHost: null,
            host: 'example.com',
            port: 2222,
            user: 'deploy',
            identityFile: '/home/deploy/.ssh/id_ed25519',
            useSshAgent: false,
          },
          rootPath: '/home/deploy',
          keepAliveSeconds: 60,
          idleDisconnectMinutes: 15,
          mappings: [],
          excludedLocalPaths: [],
          excludedRemotePaths: [],
        },
        {
          id: 'settings-inplace',
          name: 'Local',
          default: false,
          type: 'inplace',
          folder: '/var/www/app',
          webUrl: 'http://app.example.com/',
        },
      ],
    });
    assert.equal(handle.isDirty(), false);
  });

  it('edits a server, moves the default and keeps the mappings it does not show', async () => {
    // Mappings and excluded paths are edited elsewhere; saving the form must keep them.
    const { config } = await current();
    assert.ok(config);
    const [sftp, inplace] = config.servers;
    assert.ok(sftp?.type === 'sftp' && inplace !== undefined);
    await saveConfig(
      folder.uri.fsPath,
      {
        ...config,
        servers: [
          {
            ...sftp,
            mappings: [{ localPath: '.', deploymentPath: 'www/app.example.com' }],
            excludedLocalPaths: ['.git'],
          },
          inplace,
        ],
      },
      storeOptions(),
    );
    await handle.receive({ type: 'reload' });

    const edited: ServerDraft[] = [
      { ...SFTP, name: 'Production', default: false, port: '' },
      { ...INPLACE, default: true },
    ];
    await handle.receive({ type: 'draft', servers: edited });
    assert.equal(handle.isDirty(), true);
    await handle.receive({ type: 'save', servers: edited });

    const saved = (await current()).config;
    assert.ok(saved);
    assert.deepEqual(
      saved.servers.map((server) => [server.name, server.default]),
      [
        ['Production', false],
        ['Local', true],
      ],
    );
    const [first] = saved.servers;
    assert.ok(first?.type === 'sftp');
    assert.equal(first.connection.port, null);
    assert.deepEqual(first.mappings, [{ localPath: '.', deploymentPath: 'www/app.example.com' }]);
    assert.deepEqual(first.excludedLocalPaths, ['.git']);
  });

  it('reports invalid fields and saves nothing', async () => {
    const before = readFileSync((await current()).file, 'utf8');
    await handle.receive({
      type: 'save',
      servers: [{ ...SFTP, rootPath: 'relative', port: 'abc' }, INPLACE],
    });
    const fields = lastOf(handle, 'errors').errors.map((error) => error.field);
    assert.deepEqual(fields.sort(), ['port', 'rootPath']);
    assert.equal(readFileSync((await current()).file, 'utf8'), before);
    await handle.receive({ type: 'reload' });
  });

  it('never overwrites a configuration that was changed outside the panel', async () => {
    const { file, config } = await current();
    assert.ok(config);
    const outside = `${JSON.stringify({ ...config, servers: [] }, null, 2)}\n`;
    writeFileSync(file, outside);

    await handle.receive({ type: 'save', servers: [{ ...SFTP, name: 'Mine' }] });
    assert.equal(readFileSync(file, 'utf8'), outside);
    assert.ok(handle.posted().some((message) => message.type === 'changedOnDisk'));

    await handle.receive({ type: 'reload' });
    assert.deepEqual(lastOf(handle, 'state').saved, []);
    assert.equal(handle.isDirty(), false);
  });

  it('deletes a server', async () => {
    await handle.receive({ type: 'save', servers: [SFTP, INPLACE] });
    await handle.receive({ type: 'save', servers: [INPLACE] });
    assert.deepEqual(
      (await current()).config?.servers.map((server) => server.id),
      ['settings-inplace'],
    );
  });
});
