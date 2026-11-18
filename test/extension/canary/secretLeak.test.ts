import { strict as assert } from 'node:assert';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setFlagsFromString, writeHeapSnapshot } from 'node:v8';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as vscode from 'vscode';
import type { TestConnectionResult } from '../../../src/commands/connectionCommands';
import type { Ssh2Module } from '../../../src/ssh/connectionManager';
import { sftpServer } from '../../support/connectionFixture';
import { startSshd, type SshdContainer } from '../../support/sshd';
import { extensionUnderTest } from '../extensionUnderTest';
import {
  configureServer,
  instanceHome,
  instanceRoot,
  outputChannelFiles,
  requiredEnv,
  waitForLogText,
  writeSshFiles,
} from '../support/instance';
import type { AgentRequest, CategoryReport } from './canaryAgent';

/**
 * A helper process that holds the canary passphrase (canaryAgent.ts). This process, the
 * extension host, never learns it, so its heap can be searched for it.
 */
class Agent {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly answers: ((line: string) => void)[] = [];

  constructor() {
    const env: Record<string, string> = {};
    // Only what docker needs; the extension host's environment is already an allowlist.
    for (const name of ['PATH', 'HOME', 'TMPDIR', 'DOCKER_HOST', 'SystemRoot']) {
      const value = process.env[name];
      if (value !== undefined) {
        env[name] = value;
      }
    }
    this.child = spawn(
      requiredEnv('VSCODE_DEPLOYMENT_TEST_NODE'),
      [join(__dirname, 'canaryAgent.js')],
      { env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      this.answers.shift()?.(line);
    });
  }

  async request<T>(request: AgentRequest): Promise<T> {
    const line = await new Promise<string>((resolve) => {
      this.answers.push(resolve);
      this.child.stdin.write(`${JSON.stringify(request)}\n`);
    });
    const answer = JSON.parse(line) as { ok: boolean; result?: T; error?: string };
    if (!answer.ok) {
      throw new Error(`The canary helper failed: ${answer.error ?? 'unknown error'}`);
    }
    return answer.result as T;
  }

  stop(): void {
    this.child.stdin.end();
  }
}

/** A full garbage collection, when the extension host allows it (heap snapshots do one too). */
function collectGarbage(): void {
  setFlagsFromString('--expose-gc');
  const gc: unknown = runInNewContext('typeof gc === "function" ? gc : undefined');
  if (typeof gc === 'function') {
    (gc as () => void)();
  }
}

/** Keeps the control strings alive while a heap snapshot is written. */
const retained: string[] = [];

/** Only the names of the needles found, without the file. */
function found(report: CategoryReport): string[] {
  return report.hits.map((hit) => hit.slice(0, hit.indexOf(' in ')));
}

function assertSearched(name: string, report: CategoryReport | undefined): CategoryReport {
  assert.ok(report, `${name} was not searched`);
  assert.deepEqual(report.unreadable, [], `${name}: files could not be read`);
  assert.ok(report.files > 0, `${name}: no file was searched`);
  assert.ok(report.bytes > 0, `${name}: no byte was searched`);
  return report;
}

// The passphrase is typed into the real input box of a VS Code
// instance with trace logging (see the `canary` configuration in .vscode-test.mjs), the key is
// decrypted and used for a login, and then every file the instance wrote, the Deployment output
// channel and heap snapshots of the extension host are searched for the passphrase and the
// decrypted key.
describe('secret leak canary', () => {
  let sshd: SshdContainer | undefined;
  let agent: Agent | undefined;
  let removeConfig: (() => void) | undefined;
  const root = instanceRoot();
  const userData = requiredEnv('VSCODE_DEPLOYMENT_TEST_USER_DATA');
  const heapDir = join(root, 'heap');
  // Made from a Buffer, so that V8 holds it as one flat string: a heap snapshot shows a string
  // built by concatenation as its parts, and the search would not find it.
  const marker = Buffer.from(`heap-control-${randomBytes(8).toString('hex')}`).toString('latin1');

  function ssh2Bundle(): string {
    return join(extensionUnderTest().extensionPath, 'dist', 'ssh2.js');
  }

  function helper(): Agent {
    assert.ok(agent, 'the canary helper did not start');
    return agent;
  }

  before(async () => {
    await extensionUnderTest().activate();
    assert.equal(process.env['VSCODE_DEPLOYMENT_ENVIRONMENT_SENTINEL'], undefined);
    mkdirSync(heapDir, { mode: 0o700 });
    sshd = await startSshd();
    agent = new Agent();
    const { keyFile } = writeSshFiles({
      port: sshd.clientConfig.port,
      hostKeyLine: sshd.hostKeyLines['ssh-ed25519'],
      keyName: 'id_canary',
    });
    const prepared = await helper().request<{
      encrypted: boolean;
      keyLines: number;
      controlKeyLines: number;
    }>({
      command: 'prepare',
      container: sshd.name,
      keyFile,
      allowedRoot: instanceHome(),
      ssh2Bundle: ssh2Bundle(),
      controlKey: sshd.clientConfig.privateKey,
    });
    // (a) Without the passphrase the key is useless, so a login proves the passphrase was used.
    assert.equal(prepared.encrypted, true, 'the canary key is not encrypted');
    assert.ok(prepared.keyLines > 0, 'the decrypted key has no lines to search for');
    assert.ok(prepared.controlKeyLines > 0, 'the control key has no lines to search for');
    removeConfig = await configureServer(sftpServer('canary', 'test', { name: 'Canary Server' }));
  });

  after(async () => {
    await vscode.commands.executeCommand('vscodeDeployment.disconnectAll');
    removeConfig?.();
    agent?.stop();
    await sshd?.stop();
  });

  it('(a) logs in with the passphrase typed into the real password input box', async () => {
    const pending = vscode.commands.executeCommand<TestConnectionResult | undefined>(
      'vscodeDeployment.testConnection',
      'canary',
    );
    const typed = await helper().request<{ typed: boolean }>({
      command: 'type',
      devToolsActivePort: join(userData, 'DevToolsActivePort'),
      timeoutMs: 60_000,
    });
    const result = await pending;

    assert.equal(typed.typed, true);
    assert.ok(result, 'Test Connection did not connect');
    assert.equal(result.home, '/home/deploy');
    await waitForLogText('[Canary Server] Connection: connected');
  });

  it('(f) keeps the passphrase out of the extension host heap after login', async () => {
    retained.push(marker);
    collectGarbage();
    const snapshot = writeHeapSnapshot(join(heapDir, 'after-login.heapsnapshot'));
    retained.length = 0;

    const reports = await helper().request<Record<string, CategoryReport>>({
      command: 'scan',
      categories: { heapAfterLogin: [snapshot] },
      includeKey: true,
      marker,
    });

    const report = assertSearched('heapAfterLogin', reports['heapAfterLogin']);
    // Positive control: a string the test holds is found in the same snapshot.
    assert.ok(found(report).includes('marker'), 'the control marker was not found');
    assert.deepEqual(
      found(report).filter((name) => name.startsWith('passphrase')),
      [],
      'the heap contains the passphrase',
    );
    // While connected, ssh2 may hold the decrypted key; recorded for SECURITY.md.
    const keyHeld = found(report).some((name) => name.startsWith('decrypted key'));
    console.log(`      decrypted key in the heap while connected: ${keyHeld ? 'yes' : 'no'}`);
  });

  it('(f) keeps the decrypted key out of the extension host heap after Disconnect', async () => {
    await vscode.commands.executeCommand('vscodeDeployment.disconnectAll');
    await waitForLogText('[Canary Server] Connection: disconnected');
    // Positive control: a key parsed by the same ssh2 bundle, held by the test.
    assert.ok(sshd, 'the test SSH server did not start');
    const ssh2 = createRequire(ssh2Bundle())(ssh2Bundle()) as Ssh2Module;
    const control = ssh2.utils.parseKey(Buffer.from(sshd.clientConfig.privateKey));
    assert.ok(!(control instanceof Error), 'the control key cannot be parsed');
    retained.push(marker, control.getPrivatePEM());
    collectGarbage();
    const snapshot = writeHeapSnapshot(join(heapDir, 'after-disconnect.heapsnapshot'));
    retained.length = 0;

    const reports = await helper().request<Record<string, CategoryReport>>({
      command: 'scan',
      categories: { heapAfterDisconnect: [snapshot] },
      includeKey: true,
      marker,
    });

    const report = assertSearched('heapAfterDisconnect', reports['heapAfterDisconnect']);
    const names = found(report);
    assert.ok(names.includes('marker'), 'the control marker was not found');
    assert.ok(
      names.some((name) => name.startsWith('control key line')),
      'the parsed control key held by the test was not found',
    );
    // The OpenSSH text of the control key (held by the test as a string) has the seed in
    // wrapped base64, the form the extension builds from a decrypted OpenSSH key.
    assert.ok(
      names.some((name) => name.startsWith('control key seed')),
      'the seed of the control key was not found',
    );
    assert.deepEqual(
      names.filter((name) => name.startsWith('passphrase') || name.startsWith('decrypted key')),
      [],
      'the heap contains the passphrase or the decrypted key',
    );
  });

  it('(b, d) finds the passphrase in every searched encoding in control files', async () => {
    const result = await helper().request<{
      needles: number;
      found: number;
      missed: string[];
      falseHits: string[];
    }>({ command: 'control', dir: join(root, 'control') });

    assert.ok(result.needles >= 10, 'too few encodings are searched');
    assert.deepEqual(result.missed, []);
    assert.deepEqual(result.falseHits, []);
  });

  it('(c, d, e) finds neither the passphrase nor the key anywhere VS Code wrote', async () => {
    const logs = join(userData, 'logs');
    const reports = await helper().request<Record<string, CategoryReport>>({
      command: 'scan',
      categories: {
        // The profile; its logs folder is a category of its own.
        userData: [userData],
        logs: [logs],
        extensions: [
          requiredEnv('VSCODE_DEPLOYMENT_TEST_EXTENSIONS_DIR'),
          extensionUnderTest().extensionPath,
        ],
        homeAndXdg: [instanceHome(), join(root, 'x')],
        outputChannel: outputChannelFiles(),
      },
      includeKey: true,
      // With --log trace VS Code writes its environment to main.log; the variables of the
      // process that started the tests must not be in it (.vscode-test.mjs sets this one),
      // while an allowlisted one must (otherwise the environment was not logged at all and the
      // check proves nothing).
      texts: [
        { name: 'environment sentinel', text: 'VSCODE_DEPLOYMENT_ENVIRONMENT_SENTINEL' },
        { name: 'allowlisted variable', text: 'VSCODE_DEPLOYMENT_TEST_ROOT' },
      ],
    });

    for (const name of ['userData', 'logs', 'extensions', 'homeAndXdg', 'outputChannel']) {
      const report = assertSearched(name, reports[name]);
      assert.deepEqual(
        found(report).filter((needle) => needle !== 'allowlisted variable'),
        [],
        `${name} contains the passphrase, the key or the sentinel`,
      );
    }
    const logsReport = assertSearched('logs', reports['logs']);
    assert.ok(
      found(logsReport).includes('allowlisted variable'),
      'the logs do not contain the environment, so the sentinel check proves nothing',
    );
    assert.ok(logsReport.lines > 0, 'the logs have no lines');
    assert.ok((reports['outputChannel']?.lines ?? 0) > 0, 'the output channel has no lines');
    // For SECURITY.md: what was searched.
    for (const [name, report] of Object.entries(reports)) {
      console.log(
        `      ${name}: ${report.files} files, ${report.bytes} bytes, ${report.lines} lines`,
      );
    }
  });
});
