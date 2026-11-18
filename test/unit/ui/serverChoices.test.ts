import { describe, expect, it } from 'vitest';
import type { FoldersSnapshot } from '../../../src/config/folders';
import type { DeploymentConfig, InplaceServer } from '../../../src/config/model';
import {
  configuredSftpServers,
  connectionKey,
  findChoice,
  type SftpServerChoice,
} from '../../../src/ui/serverChoices';
import { sftpServer } from '../../support/connectionFixture';

const inplace: InplaceServer = {
  id: 'local',
  name: 'Local',
  default: false,
  type: 'inplace',
  folder: '/var/www/app',
  webUrl: null,
};

function config(servers: DeploymentConfig['servers']): DeploymentConfig {
  return { version: 1, projectPath: '/var/www/app', servers };
}

describe('configuredSftpServers', () => {
  it('lists the SFTP servers of every loaded folder with their config file', () => {
    const snapshot: FoldersSnapshot = {
      statuses: [
        {
          folder: { key: 'file:///var/www/app', name: 'app', fsPath: '/var/www/app' },
          result: {
            status: 'ok',
            dir: '/home/deploy/.config/vscode-deployment/projects/-var-www-app',
            config: config([sftpServer('a', 'prod'), inplace]),
            migratedFrom: null,
          },
        },
        {
          folder: { key: 'file:///var/www/api', name: 'api', fsPath: '/var/www/api' },
          result: { status: 'invalid', dir: null, errors: ['broken'] },
        },
        {
          folder: { key: 'file:///var/www/web', name: 'web', fsPath: '/var/www/web' },
          result: { status: 'missing', dir: '/tmp/x' },
        },
      ],
      keys: { hasConfig: true, hasUploadTarget: false },
      configDirs: [],
    };

    const choices = configuredSftpServers(snapshot, 'posix');

    expect(
      choices.map((choice) => [choice.server.id, choice.folderName, choice.configFile]),
    ).toEqual([
      ['a', 'app', '/home/deploy/.config/vscode-deployment/projects/-var-www-app/config.json'],
    ]);
  });

  it('returns nothing without a usable configuration', () => {
    expect(
      configuredSftpServers(
        { statuses: [], keys: { hasConfig: false, hasUploadTarget: false }, configDirs: [] },
        'posix',
      ),
    ).toEqual([]);
  });
});

describe('findChoice', () => {
  function choice(folder: string, id: string): SftpServerChoice {
    return {
      key: connectionKey(folder, id),
      server: sftpServer(id, 'prod'),
      folderName: folder,
      configFile: `/tmp/${folder}/config.json`,
    };
  }

  it('finds a server by connection key, or by id when the id is unique', () => {
    const choices = [choice('f1', 'a'), choice('f2', 'a'), choice('f2', 'b')];

    expect(findChoice(choices, connectionKey('f2', 'a'))?.folderName).toBe('f2');
    expect(findChoice(choices, 'b')?.folderName).toBe('f2');
    // Two folders have a server "a": an id alone does not say which.
    expect(findChoice(choices, 'a')).toBeUndefined();
    expect(findChoice(choices, 'c')).toBeUndefined();
  });
});
