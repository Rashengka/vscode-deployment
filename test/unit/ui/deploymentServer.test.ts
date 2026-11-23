import { describe, expect, it } from 'vitest';
import type { SftpServer } from '../../../src/config/model';
import { deploymentPickItem, selectDeploymentServer } from '../../../src/ui/deploymentServer';
import { connectionKey, type SftpServerChoice } from '../../../src/ui/serverChoices';
import { sftpServer } from '../../support/connectionFixture';

const MAPPED = [{ localPath: '.', deploymentPath: 'www/app' }];

function choice(id: string, overrides: Partial<SftpServer> = {}): SftpServerChoice {
  return {
    key: connectionKey('file:///var/www/app', id),
    server: sftpServer(id, 'test', { mappings: MAPPED, ...overrides }),
    folderName: 'app',
    configFile: '/config.json',
  };
}

const ids = (choices: readonly SftpServerChoice[]): string[] =>
  choices.map((entry) => entry.server.id);

describe('selectDeploymentServer', () => {
  it('takes the one default server without asking', () => {
    const selection = selectDeploymentServer([
      choice('a'),
      choice('b', { default: true }),
      choice('c'),
    ]);
    expect(selection.kind).toBe('chosen');
    expect(selection.kind === 'chosen' && selection.choice.server.id).toBe('b');
  });

  it('takes the only server that can be deployed to', () => {
    const selection = selectDeploymentServer([choice('a', { mappings: [] }), choice('b')]);
    expect(selection.kind === 'chosen' && selection.choice.server.id).toBe('b');
  });

  it('asks when there is no default server, or more than one', () => {
    const none = selectDeploymentServer([choice('a'), choice('b')]);
    expect(none.kind === 'pick' && ids(none.choices)).toEqual(['a', 'b']);
    const two = selectDeploymentServer([
      choice('a', { default: true }),
      choice('b', { default: true }),
      choice('c'),
    ]);
    expect(two.kind === 'pick' && ids(two.choices)).toEqual(['a', 'b', 'c']);
  });

  it('offers only servers with a mapping, and ignores a default server without one', () => {
    const selection = selectDeploymentServer([
      choice('a', { default: true, mappings: [] }),
      choice('b'),
      choice('c'),
    ]);
    expect(selection.kind === 'pick' && ids(selection.choices)).toEqual(['b', 'c']);
    expect(selectDeploymentServer([choice('a', { mappings: [] })])).toEqual({ kind: 'none' });
    expect(selectDeploymentServer([])).toEqual({ kind: 'none' });
  });
});

describe('deploymentPickItem', () => {
  it('shows the name, the host and the deployment paths, as plain text', () => {
    const item = deploymentPickItem(
      choice('a', {
        name: 'Prod $(alert)‮',
        connection: {
          sshConfigHost: null,
          host: 'example.com',
          port: 22,
          user: 'deploy',
          identityFile: null,
          useSshAgent: false,
        },
        rootPath: '/home/deploy',
        mappings: [
          { localPath: '.', deploymentPath: 'www/app' },
          { localPath: 'public', deploymentPath: 'www/public\n' },
        ],
      }),
    );
    expect(item).toEqual({
      label: 'Prod \\$(alert)\\u202e',
      description: 'example.com',
      detail: '/home/deploy/www/app, /home/deploy/www/public\\n',
    });
  });

  it('shows the SSH config host alias when there is one', () => {
    expect(deploymentPickItem(choice('a')).description).toBe('test');
  });
});
