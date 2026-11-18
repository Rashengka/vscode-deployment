import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import type { TestConnectionResult } from '../../src/commands/connectionCommands';
import { sftpServer } from '../support/connectionFixture';
import { startSshd, type SshdContainer } from '../support/sshd';
import { extensionUnderTest } from './extensionUnderTest';
import { configureServer, waitForLogText, writeSshFiles } from './support/instance';

interface ContributedCommand {
  readonly command: string;
  readonly title: string;
  readonly category?: string;
}

const COMMANDS: readonly ContributedCommand[] = [
  { command: 'vscodeDeployment.testConnection', title: 'Test Connection', category: 'Deployment' },
  { command: 'vscodeDeployment.disconnect', title: 'Disconnect', category: 'Deployment' },
  { command: 'vscodeDeployment.disconnectAll', title: 'Disconnect All', category: 'Deployment' },
  {
    command: 'vscodeDeployment.showConnectionMenu',
    title: 'Show Connection Menu',
    category: 'Deployment',
  },
];

// The real commands of the installed extension, with the ssh files and configuration in the
// test instance's own home and configuration folder. The key is the unencrypted client key of
// the test server, so no passphrase prompt appears (the leak test covers the prompt).
describe('Test Connection and Disconnect commands', () => {
  let sshd: SshdContainer | undefined;
  let removeConfig: (() => void) | undefined;

  before(async () => {
    await extensionUnderTest().activate();
    sshd = await startSshd();
    writeSshFiles({
      port: sshd.clientConfig.port,
      hostKeyLine: sshd.hostKeyLines['ssh-ed25519'],
      keyName: 'id_test',
      key: Buffer.from(sshd.clientConfig.privateKey),
    });
    removeConfig = await configureServer(sftpServer('server-1', 'test', { name: 'Test Server' }));
  });

  after(async () => {
    await vscode.commands.executeCommand('vscodeDeployment.disconnectAll');
    removeConfig?.();
    await sshd?.stop();
  });

  it('are contributed and registered', async () => {
    const packageJson = extensionUnderTest().packageJSON as {
      contributes: { commands: ContributedCommand[] };
    };
    const registered = await vscode.commands.getCommands(true);
    for (const expected of COMMANDS) {
      assert.deepEqual(
        packageJson.contributes.commands.find((entry) => entry.command === expected.command),
        expected,
      );
      assert.ok(registered.includes(expected.command), `${expected.command} is not registered`);
    }
  });

  it('connects and reports the user, the home directory and the sanitized banner', async () => {
    const result = await vscode.commands.executeCommand<TestConnectionResult | undefined>(
      'vscodeDeployment.testConnection',
      'server-1',
    );

    assert.ok(result, 'Test Connection did not connect');
    assert.equal(result.serverName, 'Test Server');
    assert.equal(result.user, 'deploy');
    assert.equal(result.home, '/home/deploy');
    // test/support/sshd/entrypoint.sh: an escape sequence and a right-to-left override.
    assert.ok(result.banner?.includes('Test banner\n\\x1b[31mred\\x1b[0m \\u202etxt.exe'));
    const banner = result.banner ?? '';
    // eslint-disable-next-line no-control-regex -- finding control characters is the point
    assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(banner));
  });

  it('logs the connection with the server name, on one line per entry, sanitized', async () => {
    const log = await waitForLogText('[Test Server] Test Connection: connected as deploy');

    assert.ok(
      log.includes('[Test Server] Banner: Test banner\\n\\x1b[31mred\\x1b[0m \\u202etxt.exe'),
    );
    assert.ok(log.includes('home directory /home/deploy'));
    assert.ok(!log.includes('\u001b'), 'the log contains a raw escape character');
    assert.ok(!log.includes('‮'), 'the log contains a raw bidi override');
  });

  it('disconnects all connections', async () => {
    await vscode.commands.executeCommand('vscodeDeployment.disconnectAll');

    const log = await waitForLogText('[Test Server] Connection: disconnected');
    assert.ok(log.includes('Disconnect All'));
  });
});
