/**
 * The folders of the VS Code instance that runs the tests (see `.vscode-test.mjs`), and the
 * ssh files the extension itself reads there. The extension reads `~/.ssh` of the extension
 * host, so these tests write into it; {@link instanceHome} makes sure that this home directory
 * belongs to the test instance and is never the home of the person running the tests.
 */
import { strict as assert } from 'node:assert';
import {
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import * as vscode from 'vscode';
import { ensureConfigFile, saveConfig, type StoreOptions } from '../../../src/config/store';
import type { Server } from '../../../src/config/model';

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  assert.ok(value, `${name} is not set`);
  return value;
}

/** Folder of everything the test instance writes. */
export function instanceRoot(): string {
  return realpathSync(requiredEnv('VSCODE_DEPLOYMENT_TEST_ROOT'));
}

/** The home directory of the extension host, after checking that it is the test instance's. */
export function instanceHome(): string {
  const home = realpathSync(homedir());
  assert.ok(isInside(instanceRoot(), home), 'HOME is not a folder of the test instance');
  return home;
}

export function storeOptions(): StoreOptions {
  const root = requiredEnv('VSCODE_DEPLOYMENT_CONFIG_DIR');
  // The folder may not exist yet, so compare the paths as given.
  assert.ok(
    isInside(requiredEnv('VSCODE_DEPLOYMENT_TEST_ROOT'), root),
    'the config dir must be a test folder',
  );
  return { root };
}

export interface SshFiles {
  readonly keyFile: string;
}

/**
 * Writes `~/.ssh/config` (alias `test` for the test server), `~/.ssh/known_hosts` and a key
 * file into the test instance's home.
 */
export function writeSshFiles(options: {
  readonly port: number;
  readonly hostKeyLine: string;
  readonly keyName: string;
  readonly key?: Buffer;
}): SshFiles {
  const sshDir = join(instanceHome(), '.ssh');
  mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  const keyFile = join(sshDir, options.keyName);
  if (options.key !== undefined) {
    writeFileSync(keyFile, options.key, { mode: 0o600 });
  }
  const knownHosts = join(sshDir, 'known_hosts');
  writeFileSync(knownHosts, `[127.0.0.1]:${options.port} ${options.hostKeyLine}\n`, {
    mode: 0o600,
  });
  writeFileSync(
    join(sshDir, 'config'),
    [
      'Host test',
      '  HostName 127.0.0.1',
      `  Port ${options.port}`,
      '  User deploy',
      `  IdentityFile "${keyFile}"`,
      '  IdentitiesOnly yes',
      `  UserKnownHostsFile "${knownHosts}"`,
      '  GlobalKnownHostsFile none',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  return { keyFile };
}

function isServerList(server: Server | readonly Server[]): server is readonly Server[] {
  return Array.isArray(server);
}

/**
 * Saves a configuration with `server` (or several servers) for the first workspace folder,
 * replacing any configuration it has, and returns a function that removes it again (other
 * tests expect the folder to start without a configuration).
 */
export async function configureServer(server: Server | readonly Server[]): Promise<() => void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'the test instance has no workspace folder');
  const options = storeOptions();
  await ensureConfigFile(folder.uri.fsPath, options);
  const projectPath = realpathSync(folder.uri.fsPath);
  const servers: Server[] = isServerList(server) ? [...server] : [server];
  const file = await saveConfig(folder.uri.fsPath, { version: 1, projectPath, servers }, options);
  return () => {
    rmSync(dirname(file), { recursive: true, force: true });
  };
}

/** Every file below `dir` (not following symbolic links). */
export function filesBelow(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...filesBelow(path));
    } else if (entry.isFile()) {
      found.push(path);
    }
  }
  return found;
}

/** The files VS Code writes the `Deployment` output channel to (one per window session). */
export function outputChannelFiles(): string[] {
  const logs = join(requiredEnv('VSCODE_DEPLOYMENT_TEST_USER_DATA'), 'logs');
  return filesBelow(logs).filter((file) => basename(file) === 'Deployment.log');
}

/** Waits until the output channel file contains `text`, and returns its content. */
export async function waitForLogText(text: string, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const content = outputChannelFiles()
      .filter((file) => statSync(file).size > 0)
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    if (content.includes(text)) {
      return content;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `The Deployment log did not contain the expected entry within ${timeoutMs} ms.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
