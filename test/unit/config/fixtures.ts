import type { InplaceServer, SftpServer } from '../../../src/config/model';

export const PROJECT = '/var/www/app';

export function sftpServer(overrides: Partial<SftpServer> = {}): SftpServer {
  return {
    id: 'a1b2c3',
    name: 'Production',
    default: true,
    type: 'sftp',
    connection: { sshConfigHost: 'app', host: null, port: null, user: null, identityFile: null },
    rootPath: '/home/deploy',
    keepAliveSeconds: 300,
    idleDisconnectMinutes: 0,
    mappings: [{ localPath: '.', deploymentPath: 'www/app.example.com' }],
    excludedLocalPaths: ['.git', 'node_modules'],
    excludedRemotePaths: [],
    ...overrides,
  };
}

export function inplaceServer(overrides: Partial<InplaceServer> = {}): InplaceServer {
  return {
    id: 'd4e5f6',
    name: 'Local',
    default: false,
    type: 'inplace',
    folder: '/var/www/app',
    webUrl: 'http://app.example.com/',
    ...overrides,
  };
}

/** A plain JSON copy, so that tests can add or change properties freely. */
export function json(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}
