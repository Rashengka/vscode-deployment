import { describe, expect, it } from 'vitest';
import type { DeploymentConfig } from '../../../src/config/model';
import { validateConfig } from '../../../src/config/validate';
import { newServerDraft, type ServerDraft, type SftpDraft } from '../../../src/settings/draft';
import {
  buildConfig,
  draftFromServer,
  draftsFromConfig,
  sftpServerFromDraft,
} from '../../../src/settings/save';
import { PROJECT, inplaceServer, sftpServer } from '../config/fixtures';

const options = { platform: 'linux' as const };

const KEY_BLOCK_START = ['-----BEGIN', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ');

function stored(): DeploymentConfig {
  return {
    version: 1,
    projectPath: PROJECT,
    servers: [
      sftpServer({
        connection: {
          sshConfigHost: 'app',
          host: null,
          port: 2222,
          user: null,
          identityFile: '/home/deploy/.ssh/id_ed25519',
          useSshAgent: true,
        },
        mappings: [
          { localPath: '.', deploymentPath: 'www/app.example.com' },
          { localPath: 'public', deploymentPath: 'www/static' },
        ],
        excludedLocalPaths: ['.git', 'node_modules'],
        excludedRemotePaths: ['cache'],
      }),
      inplaceServer(),
    ],
  };
}

function sftpDraft(drafts: readonly ServerDraft[]): SftpDraft {
  const draft = drafts[0];
  if (draft?.type !== 'sftp') {
    throw new Error('expected an SFTP draft first');
  }
  return draft;
}

function newSftp(id: string, overrides: Partial<SftpDraft> = {}): SftpDraft {
  return { ...(newServerDraft('sftp', id, []) as SftpDraft), ...overrides };
}

function newInplace(id: string, overrides: Partial<ServerDraft> = {}): ServerDraft {
  return { ...newServerDraft('inplace', id, []), folder: PROJECT, ...overrides } as ServerDraft;
}

describe('draftFromServer', () => {
  it('shows an SFTP server with an alias as text fields', () => {
    expect(draftFromServer(sftpServer())).toEqual({
      id: 'a1b2c3',
      type: 'sftp',
      name: 'Production',
      default: true,
      mode: 'alias',
      sshConfigHost: 'app',
      host: '',
      port: '',
      user: '',
      identityFile: '',
      rootPath: '/home/deploy',
      keepAliveSeconds: '300',
      idleDisconnectMinutes: '0',
      mappings: [{ localPath: '.', deploymentPath: 'www/app.example.com' }],
      excludedLocalPaths: ['.git', 'node_modules'],
      excludedRemotePaths: [],
    });
  });

  it('shows a manual connection in manual mode', () => {
    const draft = draftFromServer(
      sftpServer({
        connection: {
          sshConfigHost: null,
          host: 'example.com',
          port: 22,
          user: 'deploy',
          identityFile: null,
          useSshAgent: false,
        },
      }),
    );
    expect(draft).toMatchObject({
      mode: 'manual',
      host: 'example.com',
      port: '22',
      user: 'deploy',
    });
  });

  it('shows an in-place server', () => {
    expect(draftFromServer(inplaceServer({ webUrl: null }))).toEqual({
      id: 'd4e5f6',
      type: 'inplace',
      name: 'Local',
      default: false,
      folder: '/var/www/app',
      webUrl: '',
    });
  });
});

describe('buildConfig', () => {
  it('gives back the stored configuration unchanged, including what the form does not edit', () => {
    const config = stored();
    const result = buildConfig(PROJECT, draftsFromConfig(config), config.servers, options);
    expect(result).toEqual({ ok: true, config });
  });

  it('keeps mappings, excluded paths and the agent setting when other fields change', () => {
    const config = stored();
    const drafts = draftsFromConfig(config);
    const edited: ServerDraft[] = [
      { ...sftpDraft(drafts), name: 'Live', rootPath: '/var/www/app', port: '' },
      ...drafts.slice(1),
    ];
    const result = buildConfig(PROJECT, edited, config.servers, options);
    if (!result.ok) {
      throw new Error(JSON.stringify(result.errors));
    }
    const [server] = result.config.servers;
    const original = config.servers[0];
    expect(server).toMatchObject({
      name: 'Live',
      rootPath: '/var/www/app',
      mappings: original?.type === 'sftp' ? original.mappings : [],
      excludedLocalPaths: ['.git', 'node_modules'],
      excludedRemotePaths: ['cache'],
      connection: { port: null, useSshAgent: true, identityFile: '/home/deploy/.ssh/id_ed25519' },
    });
    expect(validateConfig(result.config, options).ok).toBe(true);
  });

  it('creates new servers with empty mappings and without the SSH agent', () => {
    const draft = newSftp('new-1', {
      mode: 'manual',
      host: ' example.com ',
      user: 'deploy',
      port: '2222',
      rootPath: '/home/deploy',
    });
    const result = buildConfig(PROJECT, [draft], [], options);
    expect(result).toEqual({
      ok: true,
      config: {
        version: 1,
        projectPath: PROJECT,
        servers: [
          {
            id: 'new-1',
            name: 'New Server',
            default: true,
            type: 'sftp',
            connection: {
              sshConfigHost: null,
              host: 'example.com',
              port: 2222,
              user: 'deploy',
              identityFile: null,
              useSshAgent: false,
            },
            rootPath: '/home/deploy',
            keepAliveSeconds: 300,
            idleDisconnectMinutes: 0,
            mappings: [],
            excludedLocalPaths: [],
            excludedRemotePaths: [],
          },
        ],
      },
    });
  });

  it('uses only the alias in alias mode and only the host in manual mode', () => {
    const alias = buildConfig(
      PROJECT,
      [newSftp('n', { rootPath: '/home/deploy', sshConfigHost: 'app', host: 'example.org' })],
      [],
      options,
    );
    const manual = buildConfig(
      PROJECT,
      [
        newSftp('n', {
          rootPath: '/home/deploy',
          mode: 'manual',
          sshConfigHost: 'app',
          host: 'example.com',
        }),
      ],
      [],
      options,
    );
    expect(alias.ok && alias.config.servers[0]).toMatchObject({
      connection: { sshConfigHost: 'app', host: null },
    });
    expect(manual.ok && manual.config.servers[0]).toMatchObject({
      connection: { sshConfigHost: null, host: 'example.com' },
    });
  });

  it('reports form errors per server and field, with the validation of config.json', () => {
    const draft = newSftp('n1', {
      name: ' ',
      mode: 'manual',
      host: '',
      port: '22x',
      rootPath: 'relative',
      keepAliveSeconds: '',
      identityFile: KEY_BLOCK_START,
    });
    const result = buildConfig(PROJECT, [draft], [], options);
    expect(result.ok).toBe(false);
    const errors = result.ok ? [] : result.errors;
    expect(errors.map((error) => [error.serverId, error.field])).toEqual(
      expect.arrayContaining([
        ['n1', 'name'],
        ['n1', 'host'],
        ['n1', 'port'],
        ['n1', 'rootPath'],
        ['n1', 'keepAliveSeconds'],
        ['n1', 'identityFile'],
      ]),
    );
    for (const error of errors) {
      // Messages name the field the way the form does, never by its position in the file, and
      // never repeat what was typed.
      expect(error.message).not.toMatch(/servers\[|BEGIN/);
    }
  });

  it('reports a missing alias on the alias field', () => {
    const result = buildConfig(PROJECT, [newSftp('n1', { rootPath: '/home/deploy' })], [], options);
    expect(result.ok ? [] : result.errors).toEqual([
      { serverId: 'n1', field: 'sshConfigHost', message: 'Choose an SSH config host.' },
    ]);
  });

  it('reports duplicate names with the name of the other server', () => {
    const result = buildConfig(
      PROJECT,
      [newInplace('a'), newInplace('b', { name: 'local', default: false })],
      [],
      options,
    );
    expect(result.ok ? [] : result.errors).toEqual([
      { serverId: 'b', field: 'name', message: 'Name: is already used by "Local"' },
    ]);
  });

  it('reports an invalid web URL of an in-place server', () => {
    const result = buildConfig(
      PROJECT,
      [newInplace('a', { webUrl: 'ftp://example.com/' })],
      [],
      options,
    );
    expect(result.ok ? [] : result.errors).toEqual([
      { serverId: 'a', field: 'webUrl', message: 'Web URL: must be an http or https URL' },
    ]);
  });

  it('reports more than one default for the whole configuration', () => {
    const result = buildConfig(
      PROJECT,
      [newInplace('a'), newInplace('b', { name: 'Other', default: true })],
      [],
      options,
    );
    expect(result.ok ? [] : result.errors).toEqual([
      { serverId: null, field: null, message: 'at most one server may be the default (found 2)' },
    ]);
  });
});

describe('sftpServerFromDraft', () => {
  it('builds the server Test Connection uses, with what the form does not edit', () => {
    const config = stored();
    const draft = { ...sftpDraft(draftsFromConfig(config)), user: 'deploy' };
    const result = sftpServerFromDraft(PROJECT, draft, config.servers, options);
    expect(result.ok && result.server).toMatchObject({
      id: 'a1b2c3',
      connection: { sshConfigHost: 'app', user: 'deploy', useSshAgent: true },
      mappings: [{ localPath: '.' }, { localPath: 'public' }],
    });
  });

  it('reports the errors of that server only', () => {
    const result = sftpServerFromDraft(PROJECT, newSftp('n', { rootPath: '' }), [], options);
    expect(result.ok ? [] : result.errors.map((error) => error.field)).toEqual([
      'sshConfigHost',
      'rootPath',
    ]);
  });
});

describe('buildConfig with mappings and excluded paths', () => {
  it('saves the mappings and excluded paths of the form, trimmed', () => {
    const config = stored();
    const drafts = draftsFromConfig(config);
    const edited: ServerDraft[] = [
      {
        ...sftpDraft(drafts),
        mappings: [
          { localPath: ' src ', deploymentPath: 'www/app/src ' },
          { localPath: 'public', deploymentPath: '' },
        ],
        excludedLocalPaths: ['var/cache'],
        excludedRemotePaths: [' logs '],
      },
      ...drafts.slice(1),
    ];
    const result = buildConfig(PROJECT, edited, config.servers, options);
    if (!result.ok) {
      throw new Error(JSON.stringify(result.errors));
    }
    expect(result.config.servers[0]).toMatchObject({
      mappings: [
        { localPath: 'src', deploymentPath: 'www/app/src' },
        { localPath: 'public', deploymentPath: '' },
      ],
      excludedLocalPaths: ['var/cache'],
      excludedRemotePaths: ['logs'],
    });
    expect(validateConfig(result.config, options).ok).toBe(true);
  });

  it('refuses paths that leave the project or the root path, on the row that has them', () => {
    const result = buildConfig(
      PROJECT,
      [
        newSftp('s1', {
          sshConfigHost: 'app',
          rootPath: '/home/deploy',
          mappings: [
            { localPath: '.', deploymentPath: 'www' },
            { localPath: '../other', deploymentPath: '/etc' },
          ],
          excludedLocalPaths: ['', '/home/deploy/.ssh', '.'],
          excludedRemotePaths: ['a\\b'],
        }),
      ],
      [],
      options,
    );
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors).toEqual([
      {
        serverId: 's1',
        field: 'mappings.1.localPath',
        message: 'Mapping 2, local path: must not contain ".."',
      },
      {
        serverId: 's1',
        field: 'mappings.1.deploymentPath',
        message: 'Mapping 2, deployment path: must be a relative path',
      },
      {
        serverId: 's1',
        field: 'excludedLocalPaths.0',
        message: 'Excluded local path 1: must not be empty',
      },
      {
        serverId: 's1',
        field: 'excludedLocalPaths.1',
        message: 'Excluded local path 2: must be a relative path',
      },
      {
        serverId: 's1',
        field: 'excludedLocalPaths.2',
        message:
          'Excluded local path 3: must name a file or folder inside the project, not the project folder',
      },
      {
        serverId: 's1',
        field: 'excludedRemotePaths.0',
        message: 'Excluded remote path 1: must use forward slashes',
      },
    ]);
  });
});
