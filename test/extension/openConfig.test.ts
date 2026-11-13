import { strict as assert } from 'node:assert';
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import * as vscode from 'vscode';
import { extensionUnderTest } from './extensionUnderTest';

const OPEN_CONFIG_COMMAND = 'vscodeDeployment.openConfig';

interface ContributedCommand {
  readonly command: string;
  readonly title: string;
  readonly category?: string;
}

/** Whether `child` is inside `parent` (`relative` gives an absolute path across drives). */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function testConfigDir(): string {
  const dir = process.env['VSCODE_DEPLOYMENT_CONFIG_DIR'];
  assert.ok(dir, 'VSCODE_DEPLOYMENT_CONFIG_DIR is not set; the test would use the real config');
  // Never the real configuration location of the user running the tests.
  for (const real of [join(homedir(), '.config'), process.env['APPDATA']]) {
    if (real !== undefined) {
      assert.ok(!isInside(real, dir) && real !== dir, 'the config dir must be a test folder');
    }
  }
  return dir;
}

describe('Open Deployment Config (JSON) command', () => {
  let workspaceFolder: vscode.WorkspaceFolder;

  before(async () => {
    await extensionUnderTest().activate();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'the test instance has no workspace folder');
    workspaceFolder = folder;
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('is contributed with its title and category and registered', async () => {
    const packageJson = extensionUnderTest().packageJSON as {
      contributes: { commands: ContributedCommand[] };
    };
    const contributed = packageJson.contributes.commands.find(
      (entry) => entry.command === OPEN_CONFIG_COMMAND,
    );
    assert.deepEqual(contributed, {
      command: OPEN_CONFIG_COMMAND,
      title: 'Open Deployment Config (JSON)',
      category: 'Deployment',
    });
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes(OPEN_CONFIG_COMMAND), `${OPEN_CONFIG_COMMAND} is not registered`);
  });

  it('creates an empty valid configuration in the config folder and opens it', async () => {
    const configDir = testConfigDir();
    const uri = await vscode.commands.executeCommand<vscode.Uri | undefined>(OPEN_CONFIG_COMMAND);

    assert.ok(uri, 'the command did not open a file');
    assert.ok(
      isInside(configDir, uri.fsPath),
      'the file was created outside the test config folder',
    );
    assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, uri.fsPath);
    assert.deepEqual(JSON.parse(readFileSync(uri.fsPath, 'utf8')), {
      version: 1,
      projectPath: realpathSync.native(workspaceFolder.uri.fsPath),
      servers: [],
    });
    if (process.platform !== 'win32') {
      assert.equal(statSync(uri.fsPath).mode & 0o777, 0o600);
    }
  });

  it('opens the existing file again without replacing it', async () => {
    const first = await vscode.commands.executeCommand<vscode.Uri | undefined>(OPEN_CONFIG_COMMAND);
    assert.ok(first);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const edited = `${readFileSync(first.fsPath, 'utf8').trimEnd()}\n\n`;
    writeFileSync(first.fsPath, edited);

    const second = await vscode.commands.executeCommand<vscode.Uri | undefined>(
      OPEN_CONFIG_COMMAND,
    );
    assert.equal(second?.fsPath, first.fsPath);
    assert.equal(readFileSync(first.fsPath, 'utf8'), edited);
  });
});
