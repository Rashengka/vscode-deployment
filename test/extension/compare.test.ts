import { strict as assert } from 'node:assert';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { CompareCommandResult } from '../../src/commands/compareCommand';
import type { InplaceServer } from '../../src/config/model';
import { sftpServer } from '../support/connectionFixture';
import { startSshd, type SshdContainer } from '../support/sshd';
import { extensionUnderTest } from './extensionUnderTest';
import { configureServer, writeSshFiles } from './support/instance';

const COMPARE_COMMAND = 'vscodeDeployment.compareWithDeployed';
const REMOTE_SCHEME = 'vscode-deployment-remote';
const FOLDER = 'compare-test';
const REMOTE_DIR = `/home/deploy/www/app/${FOLDER}`;
const REMOTE_TEXT = '<?php\necho "deployed";\n';
const LOCAL_TEXT = '<?php\necho "local";\n';

interface PackageJson {
  readonly contributes: {
    readonly commands: readonly { command: string; title: string; category?: string }[];
    readonly menus: Readonly<Record<string, readonly Record<string, string>[]>>;
    readonly submenus: readonly { id: string; label: string }[];
    readonly keybindings: readonly Record<string, string>[];
  };
}

async function closeAllEditors(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

async function rejection(promise: Thenable<unknown>): Promise<unknown> {
  return Promise.resolve(promise).then(
    () => undefined,
    (error: unknown) => error,
  );
}

/** The diff tab Compare opened (the active tab), with its two sides. */
function activeDiff(): { tab: vscode.Tab; input: vscode.TabInputTextDiff } {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  assert.ok(tab, 'no tab is active');
  assert.ok(tab.input instanceof vscode.TabInputTextDiff, 'the active tab is not a diff');
  return { tab, input: tab.input };
}

const testServer = sftpServer('compare-1', 'test', {
  name: 'Test Server',
  mappings: [{ localPath: '.', deploymentPath: 'www/app' }],
});

/** Fails instead of waiting for a QuickPick nobody answers. */
async function withoutPicker<T>(promise: Thenable<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('the command did not finish (a server picker is probably open)'));
    }, 15_000);
  });
  try {
    return await Promise.race([Promise.resolve(promise), timeout]);
  } finally {
    clearTimeout(timer);
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
  }
}

// The real command of the installed extension against the test server, with a local folder
// in the test instance's workspace mapped to `www/app` on the server.
describe('Compare with Deployed Version', () => {
  let sshd: SshdContainer | undefined;
  let removeConfig: (() => void) | undefined;
  let localDir: string;

  function local(name: string): vscode.Uri {
    return vscode.Uri.file(join(localDir, name));
  }

  async function compare(name: string): Promise<CompareCommandResult | undefined> {
    return vscode.commands.executeCommand<CompareCommandResult | undefined>(
      COMPARE_COMMAND,
      local(name),
    );
  }

  before(async () => {
    await extensionUnderTest().activate();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'the test instance has no workspace folder');
    localDir = join(folder.uri.fsPath, FOLDER);
    mkdirSync(localDir, { recursive: true });
    for (const name of ['index.php', 'missing.php', 'logo.png']) {
      writeFileSync(join(localDir, name), LOCAL_TEXT);
    }
    // A symbolic link inside the project to a project file, and a folder.
    symlinkSync('index.php', join(localDir, 'link.php'));
    mkdirSync(join(localDir, 'folder'));
    sshd = await startSshd();
    await sshd.exec(
      [
        'set -eu',
        `mkdir -p ${REMOTE_DIR}`,
        `printf '%s' "$1" > ${REMOTE_DIR}/index.php`,
        `printf 'PNG\\000\\001' > ${REMOTE_DIR}/logo.png`,
        'chown -R deploy:deploy /home/deploy',
      ].join('\n'),
      REMOTE_TEXT,
    );
    writeSshFiles({
      port: sshd.clientConfig.port,
      hostKeyLine: sshd.hostKeyLines['ssh-ed25519'],
      keyName: 'id_test',
      key: Buffer.from(sshd.clientConfig.privateKey),
    });
    removeConfig = await configureServer(testServer);
  });

  after(async () => {
    await closeAllEditors();
    await vscode.commands.executeCommand('vscodeDeployment.disconnectAll');
    removeConfig?.();
    await sshd?.stop();
    rmSync(localDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await closeAllEditors();
  });

  it('is contributed to the Explorer, editor and tab menus in a Deployment submenu', () => {
    const { contributes } = extensionUnderTest().packageJSON as PackageJson;
    assert.deepEqual(
      contributes.commands.find((entry) => entry.command === COMPARE_COMMAND),
      { command: COMPARE_COMMAND, title: 'Compare with Deployed Version', category: 'Deployment' },
    );
    const submenu = contributes.submenus.find((entry) => entry.label === 'Deployment');
    assert.ok(submenu, 'no Deployment submenu');
    for (const location of ['explorer/context', 'editor/context', 'editor/title/context']) {
      const entry = contributes.menus[location]?.find((item) => item['submenu'] === submenu.id);
      assert.ok(entry, `the submenu is not in ${location}`);
      assert.ok(entry['when']?.includes('vscodeDeployment.hasUploadTarget'));
    }
    assert.ok(
      contributes.menus[submenu.id]?.some((item) => item['command'] === COMPARE_COMMAND),
      'the command is not in the submenu',
    );
  });

  it('has ctrl+shift+d on macOS only (it is Run and Debug on Windows and Linux)', async () => {
    const { contributes } = extensionUnderTest().packageJSON as PackageJson;
    const binding = contributes.keybindings.find((entry) => entry['command'] === COMPARE_COMMAND);
    assert.deepEqual(Object.keys(binding ?? {}).sort(), ['command', 'mac', 'when']);
    assert.equal(binding?.['mac'], 'ctrl+shift+d');

    // What VS Code made of it: the default key bindings of this platform.
    await vscode.commands.executeCommand('workbench.action.openDefaultKeybindingsFile');
    const text = vscode.window.activeTextEditor?.document.getText() ?? '';
    assert.ok(text.includes('"command": "workbench.view.debug"'), 'not the default key bindings');
    const ours = new RegExp(`"key": "([^"]+)",\\s*"command": "${COMPARE_COMMAND}"`).exec(text);
    if (process.platform === 'darwin') {
      assert.equal(ours?.[1], 'ctrl+shift+d');
    } else {
      assert.equal(ours, null);
    }
  });

  it('opens the deployed version and the local file in a diff with the right title', async () => {
    const result = await compare('index.php');

    assert.deepEqual(result, {
      outcome: 'opened',
      title: 'index.php (Test Server) ↔ Local',
      remotePath: `${REMOTE_DIR}/index.php`,
    });
    const { tab, input } = activeDiff();
    assert.equal(tab.label, 'index.php (Test Server) ↔ Local');
    assert.equal(input.original.scheme, REMOTE_SCHEME);
    assert.equal(input.original.path, `${REMOTE_DIR}/index.php`);
    assert.equal(input.modified.toString(), local('index.php').toString());
    const deployed = await vscode.workspace.openTextDocument(input.original);
    assert.equal(deployed.getText(), REMOTE_TEXT);
  });

  it('keeps the deployed version read-only', async () => {
    await compare('index.php');
    const { input } = activeDiff();

    assert.equal(vscode.workspace.fs.isWritableFileSystem(REMOTE_SCHEME), false);
    const write = await rejection(
      vscode.workspace.fs.writeFile(input.original, Buffer.from('changed')),
    );
    assert.ok(write instanceof vscode.FileSystemError, 'writing did not fail');
    assert.ok(
      (await rejection(vscode.workspace.fs.delete(input.original))) instanceof Error,
      'deleting did not fail',
    );

    // An edit in the editor cannot be applied (or saved) either.
    const edit = new vscode.WorkspaceEdit();
    edit.insert(input.original, new vscode.Position(0, 0), 'changed');
    const applied = await vscode.workspace.applyEdit(edit);
    const document = await vscode.workspace.openTextDocument(input.original);
    if (applied) {
      assert.equal(await document.save(), false, 'the deployed version was saved');
    }
    const content = await vscode.workspace.fs.readFile(input.original);
    assert.equal(Buffer.from(content).toString('utf8'), REMOTE_TEXT);
    assert.equal(
      await sshd?.exec(`cat ${REMOTE_DIR}/index.php`),
      REMOTE_TEXT,
      'the file on the server changed',
    );
  });

  it('refuses a hand-made address, also one with a valid token and another path', async () => {
    const forged = vscode.Uri.from({
      scheme: REMOTE_SCHEME,
      path: `${REMOTE_DIR}/index.php`,
      query: 'forged',
    });
    assert.ok(
      (await rejection(vscode.workspace.fs.readFile(forged))) instanceof vscode.FileSystemError,
    );
    assert.ok((await rejection(vscode.workspace.openTextDocument(forged))) instanceof Error);

    await compare('index.php');
    const { input } = activeDiff();
    const otherPath = input.original.with({ path: '/etc/passwd' });
    assert.ok(
      (await rejection(vscode.workspace.fs.readFile(otherPath))) instanceof vscode.FileSystemError,
    );
    const noToken = input.original.with({ query: '' });
    assert.ok(
      (await rejection(vscode.workspace.fs.readFile(noToken))) instanceof vscode.FileSystemError,
    );
  });

  it('forgets the deployed version when its tab closes', async () => {
    await compare('index.php');
    const { tab, input } = activeDiff();
    assert.ok((await vscode.workspace.fs.readFile(input.original)).length > 0);

    await vscode.window.tabGroups.close(tab);

    assert.ok(
      (await rejection(vscode.workspace.fs.readFile(input.original))) instanceof
        vscode.FileSystemError,
    );
  });

  it('opens no diff for a file missing on the server or a binary file', async () => {
    const missing = await compare('missing.php');
    assert.deepEqual(missing, { outcome: 'missing', remotePath: `${REMOTE_DIR}/missing.php` });
    const binary = await compare('logo.png');
    assert.deepEqual(binary, { outcome: 'binary', remotePath: `${REMOTE_DIR}/logo.png` });
    assert.equal(vscode.window.tabGroups.all.flatMap((group) => group.tabs).length, 0);
  });

  it('names a symbolic link in the project by its own name and compares its target', async () => {
    const result = await compare('link.php');

    assert.deepEqual(result, {
      outcome: 'opened',
      title: 'link.php (Test Server) ↔ Local',
      remotePath: `${REMOTE_DIR}/index.php`,
    });
    assert.equal(activeDiff().input.modified.toString(), local('link.php').toString());
  });

  it('reports a folder or a missing local file and downloads nothing', async () => {
    assert.deepEqual(await compare('folder'), { outcome: 'localNotFile' });
    assert.deepEqual(await compare('gone.php'), { outcome: 'localNotFile' });
  });

  it('uses the one default server without asking', async () => {
    const other = sftpServer('compare-0', 'test', {
      name: 'Other Server',
      mappings: [{ localPath: '.', deploymentPath: 'www/other' }],
    });
    // A configuration changed while connected is reported once by the next operation.
    await vscode.commands.executeCommand('vscodeDeployment.disconnectAll');
    removeConfig = await configureServer([other, { ...testServer, default: true }]);
    try {
      const result = await withoutPicker(
        vscode.commands.executeCommand<CompareCommandResult | undefined>(
          COMPARE_COMMAND,
          local('index.php'),
        ),
      );
      assert.ok(result !== undefined && 'title' in result, 'no diff was opened');
      assert.equal(result.title, 'index.php (Test Server) ↔ Local');
    } finally {
      await vscode.commands.executeCommand('vscodeDeployment.disconnectAll');
      removeConfig = await configureServer(testServer);
    }
  });
});

describe('Compare with Deployed Version for a folder with in-place servers only', () => {
  let removeConfig: (() => void) | undefined;
  let file: string;

  before(async () => {
    await extensionUnderTest().activate();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'the test instance has no workspace folder');
    file = join(folder.uri.fsPath, 'inplace-test.php');
    writeFileSync(file, LOCAL_TEXT);
    const inplace: InplaceServer = {
      id: 'inplace-1',
      name: 'Local',
      default: true,
      type: 'inplace',
      folder: folder.uri.fsPath,
      webUrl: null,
    };
    removeConfig = await configureServer(inplace);
  });

  after(() => {
    removeConfig?.();
    rmSync(file, { force: true });
  });

  it('says that there is no deployed version and opens nothing', async () => {
    const result = await vscode.commands.executeCommand<CompareCommandResult | undefined>(
      COMPARE_COMMAND,
      vscode.Uri.file(file),
    );
    assert.deepEqual(result, { outcome: 'inPlaceOnly' });
    assert.equal(vscode.window.tabGroups.all.flatMap((group) => group.tabs).length, 0);
  });
});
