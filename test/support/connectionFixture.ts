/**
 * A throwaway home directory with its own ssh configuration, known_hosts and keys for
 * connection tests. Nothing of the user running the tests is read: the environment points the
 * resolver at this directory only and disables the system configuration and the SSH agent.
 * Shared by the Vitest integration tests and the VS Code extension tests.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SftpServer } from '../../src/config/model';
import type { SshEnvironment } from '../../src/ssh/connectionTarget';
import type { PassphrasePrompt, PassphraseRequest } from '../../src/ssh/passphrase';
import { nodeFileAccess } from '../../src/ssh/sshConfigFiles';

export interface HostOptions {
  readonly alias: string;
  readonly port: number;
  readonly identityFiles: readonly string[];
  /** `IdentitiesOnly yes` unless false. */
  readonly identitiesOnly?: boolean;
}

export class TestHome {
  readonly root: string;
  readonly home: string;
  readonly sshDir: string;
  readonly configPath: string;
  readonly knownHostsPath: string;

  constructor() {
    this.root = mkdtempSync(join(tmpdir(), 'vscode-deployment-home-'));
    this.home = join(this.root, 'home');
    this.sshDir = join(this.home, '.ssh');
    mkdirSync(this.sshDir, { recursive: true, mode: 0o700 });
    this.configPath = join(this.sshDir, 'config');
    this.knownHostsPath = join(this.sshDir, 'known_hosts');
  }

  environment(overrides: Partial<SshEnvironment> = {}): SshEnvironment {
    return {
      homeDirectory: this.home,
      localUser: 'deploy',
      userConfigPath: this.configPath,
      systemConfigPath: null,
      agentSocket: undefined,
      remoteName: undefined,
      ...nodeFileAccess,
      ...overrides,
    };
  }

  /** Writes `~/.ssh/config` with one block per host, all using this home's known_hosts. */
  writeConfig(hosts: readonly HostOptions[]): void {
    const blocks = hosts.map((host) =>
      [
        `Host ${host.alias}`,
        '  HostName 127.0.0.1',
        `  Port ${host.port}`,
        '  User deploy',
        ...host.identityFiles.map((file) => `  IdentityFile "${file}"`),
        `  IdentitiesOnly ${host.identitiesOnly === false ? 'no' : 'yes'}`,
        `  UserKnownHostsFile "${this.knownHostsPath}"`,
        '  GlobalKnownHostsFile none',
      ].join('\n'),
    );
    writeFileSync(this.configPath, `${blocks.join('\n\n')}\n`, { mode: 0o600 });
  }

  writeKnownHosts(text: string): void {
    writeFileSync(this.knownHostsPath, text, { mode: 0o600 });
  }

  /** Writes a private key (and optionally its `.pub`) into `~/.ssh`; returns its path. */
  writeKey(name: string, content: Buffer, publicKey?: string): string {
    const path = join(this.sshDir, name);
    writeFileSync(path, content, { mode: 0o600 });
    chmodSync(path, 0o600);
    if (publicKey !== undefined) {
      writeFileSync(`${path}.pub`, `${publicKey}\n`, { mode: 0o644 });
    }
    return path;
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

/** `[127.0.0.1]:<port> <type> <base64>` for known_hosts. */
export function knownHostsLine(port: number, keyLine: string, marker = ''): string {
  const prefix = marker === '' ? '' : `${marker} `;
  return `${prefix}[127.0.0.1]:${port} ${keyLine}\n`;
}

export function sftpServer(
  id: string,
  alias: string,
  overrides: Partial<SftpServer> = {},
): SftpServer {
  return {
    id,
    name: `Test ${id}`,
    default: false,
    type: 'sftp',
    connection: {
      sshConfigHost: alias,
      host: null,
      port: null,
      user: null,
      identityFile: null,
      useSshAgent: false,
    },
    rootPath: '/home/deploy',
    keepAliveSeconds: 0,
    idleDisconnectMinutes: 0,
    mappings: [],
    excludedLocalPaths: [],
    excludedRemotePaths: [],
    ...overrides,
  };
}

/**
 * A passphrase prompt that answers from a list (`undefined` = cancel) and records what it was
 * asked. The answers are test values; they are never printed.
 */
export class ScriptedPrompt {
  readonly requests: PassphraseRequest[] = [];
  private readonly answers: (string | undefined)[];
  /** Number of prompts open at the same time, at most. */
  maxConcurrent = 0;
  private open = 0;

  constructor(answers: readonly (string | undefined)[]) {
    this.answers = [...answers];
  }

  readonly prompt: PassphrasePrompt = async (request) => {
    this.requests.push(request);
    this.open += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.open);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (this.answers.length === 0) {
        throw new Error('The test prompt was asked more often than expected.');
      }
      const answer = this.answers.shift();
      return answer === undefined ? undefined : Buffer.from(answer, 'utf8');
    } finally {
      this.open -= 1;
    }
  };
}
