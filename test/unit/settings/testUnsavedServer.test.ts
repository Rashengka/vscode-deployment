import { describe, expect, it } from 'vitest';
import { DeploymentLog } from '../../../src/log/deploymentLog';
import { testUnsavedServer } from '../../../src/settings/testUnsavedServer';
import type { DeploymentTarget } from '../../../src/transport/deploymentTarget';
import type { UnsavedTestHost } from '../../../src/settings/testUnsavedServer';
import type { TestConnectionHost } from '../../../src/ui/testConnectionFlow';
import { sftpServer } from '../../support/connectionFixture';

function fakeHost(realpath: () => Promise<string>): {
  host: UnsavedTestHost;
  runs: string[];
  disconnected: string[];
} {
  const runs: string[] = [];
  const disconnected: string[] = [];
  const sink = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const host: UnsavedTestHost = {
    connections: {
      status: () => 'disconnected',
      details: () => ({ user: 'deploy', description: 'deploy@example.com:22', banner: undefined }),
      run: ((
        reference: { key: string },
        operation: (target: DeploymentTarget) => Promise<unknown>,
      ) => {
        runs.push(reference.key);
        return operation({ realpath } as unknown as DeploymentTarget);
      }) as unknown as TestConnectionHost['connections']['run'],
      disconnect: () => {
        throw new Error('discard() is expected');
      },
      discard: (key) => {
        disconnected.push(key);
      },
    },
    log: new DeploymentLog(sink),
    withProgress: (_title, work) => work(() => undefined),
    showInformation: () => undefined,
    showError: () => undefined,
  };
  return { host, runs, disconnected };
}

const choice = {
  key: 'file:///var/www/app\na',
  server: sftpServer('a', 'app'),
  folderName: 'app',
  configFile: '/home/deploy/.config/vscode-deployment/projects/x/config.json',
};

describe('testUnsavedServer', () => {
  it('connects under a key of its own and always closes that connection', async () => {
    const ok = fakeHost(() => Promise.resolve('/home/deploy'));
    expect((await testUnsavedServer(ok.host, choice))?.home).toBe('/home/deploy');
    expect(ok.runs).toEqual(['file:///var/www/app\na\ntest']);
    expect(ok.disconnected).toEqual(['file:///var/www/app\na\ntest']);

    const failing = fakeHost(() => Promise.reject(new Error('unexpected')));
    expect(await testUnsavedServer(failing.host, choice)).toBeUndefined();
    expect(failing.disconnected).toEqual(['file:///var/www/app\na\ntest']);
  });
});
