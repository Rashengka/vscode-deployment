import { describe, expect, it } from 'vitest';
import type { SshConnection } from '../../../src/config/model';
import {
  ConnectionSettingsError,
  agentSocketFor,
  resolveConnectionTarget,
  type SshEnvironment,
} from '../../../src/ssh/connectionTarget';

function environment(files: Record<string, string>): SshEnvironment & { read: string[] } {
  const read: string[] = [];
  return {
    read,
    homeDirectory: '/home/deploy',
    localUser: 'deploy',
    platform: 'posix',
    systemConfigPath: '/etc/ssh/ssh_config',
    agentSocket: undefined,
    remoteName: undefined,
    readFile: (path) => {
      read.push(path);
      return Promise.resolve(files[path]);
    },
    listDirectory: () => Promise.resolve(undefined),
  };
}

const connection = (patch: Partial<SshConnection>): SshConnection => ({
  sshConfigHost: null,
  host: null,
  port: null,
  user: null,
  identityFile: null,
  useSshAgent: false,
  ...patch,
});

const CONFIG = [
  'Host production',
  '  HostName app.example.com',
  '  User www',
  '  Port 2200',
  '  IdentityFile ~/.ssh/deploy_key',
  '',
].join('\n');

describe('resolveConnectionTarget', () => {
  it('follows the ssh configuration for an alias and records the files it read', async () => {
    const env = environment({ '/home/deploy/.ssh/config': CONFIG });
    const target = await resolveConnectionTarget(connection({ sshConfigHost: 'production' }), env);

    expect(target.alias).toBe('production');
    expect(target.description).toBe('www@app.example.com:2200');
    expect(target.resolved.identityFiles).toEqual(['/home/deploy/.ssh/deploy_key']);
    expect(target.resolved.knownHostsName).toBe('[app.example.com]:2200');
    // The system file is read too (and so watched), even when it does not exist.
    expect(target.configFiles).toEqual(['/home/deploy/.ssh/config', '/etc/ssh/ssh_config']);
    expect(target.knownHostsFiles).toEqual([
      '/home/deploy/.ssh/known_hosts',
      '/home/deploy/.ssh/known_hosts2',
      '/etc/ssh/ssh_known_hosts',
      '/etc/ssh/ssh_known_hosts2',
    ]);
  });

  it('lets explicit port, user and identity file override the configuration', async () => {
    const env = environment({ '/home/deploy/.ssh/config': CONFIG });
    const target = await resolveConnectionTarget(
      connection({
        sshConfigHost: 'production',
        port: 22,
        user: 'deploy',
        identityFile: '~/.ssh/other',
      }),
      env,
    );

    expect(target.description).toBe('deploy@app.example.com:22');
    expect(target.resolved.knownHostsName).toBe('app.example.com');
    expect(target.resolved.identityFiles).toEqual([
      '/home/deploy/.ssh/other',
      '/home/deploy/.ssh/deploy_key',
    ]);
  });

  it('resolves a manual connection like `ssh -p port -i key user@host`', async () => {
    const env = environment({});
    const target = await resolveConnectionTarget(
      connection({
        host: 'app.example.com',
        port: 2222,
        user: 'deploy',
        identityFile: '/home/deploy/keys/id',
      }),
      env,
    );

    expect(target.alias).toBeUndefined();
    expect(target.resolved.identityFiles).toEqual(['/home/deploy/keys/id']);
    expect(target.resolved.identityFilesAreDefaults).toBe(false);
    expect(target.resolved.knownHostsName).toBe('[app.example.com]:2222');
  });

  it('uses the default keys when nothing is configured', async () => {
    const target = await resolveConnectionTarget(
      connection({ host: 'app.example.com' }),
      environment({}),
    );
    expect(target.resolved.identityFilesAreDefaults).toBe(true);
    expect(target.resolved.identityFiles).toEqual([
      '/home/deploy/.ssh/id_ed25519',
      '/home/deploy/.ssh/id_ecdsa',
      '/home/deploy/.ssh/id_rsa',
    ]);
  });

  it('refuses a relative identity file', async () => {
    await expect(
      resolveConnectionTarget(
        connection({ host: 'app.example.com', identityFile: 'keys/id' }),
        environment({}),
      ),
    ).rejects.toBeInstanceOf(ConnectionSettingsError);
  });
});

describe('agentSocketFor', () => {
  const resolved = (identityAgent: string | undefined): Parameters<typeof agentSocketFor>[0] =>
    ({ identityAgent }) as Parameters<typeof agentSocketFor>[0];

  it('prefers IdentityAgent, then SSH_AUTH_SOCK, and honours IdentityAgent none', () => {
    const env = { agentSocket: '/run/agent.sock', platform: 'posix' as const };
    expect(agentSocketFor(resolved('/run/other.sock'), env)).toBe('/run/other.sock');
    expect(agentSocketFor(resolved('SSH_AUTH_SOCK'), env)).toBe('/run/agent.sock');
    expect(agentSocketFor(resolved(undefined), env)).toBe('/run/agent.sock');
    expect(agentSocketFor(resolved('none'), env)).toBeUndefined();
  });

  it('has no agent without SSH_AUTH_SOCK on POSIX, and the OpenSSH pipe on Windows', () => {
    expect(
      agentSocketFor(resolved(undefined), { agentSocket: undefined, platform: 'posix' }),
    ).toBeUndefined();
    expect(
      agentSocketFor(resolved(undefined), { agentSocket: '', platform: 'posix' }),
    ).toBeUndefined();
    expect(agentSocketFor(resolved(undefined), { agentSocket: undefined, platform: 'win32' })).toBe(
      '\\\\.\\pipe\\openssh-ssh-agent',
    );
  });
});
