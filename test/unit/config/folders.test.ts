import { describe, expect, it } from 'vitest';
import {
  NotificationDeduplicator,
  describeProblem,
  loadFolders,
  watchSpec,
  type ConfigLoader,
  type FolderRef,
} from '../../../src/config/folders';
import type { LoadResult } from '../../../src/config/store';
import { PROJECT, sftpServer } from './fixtures';

const OPTIONS = { root: '/srv/config/vscode-deployment' };

function folder(name: string): FolderRef {
  return { key: `file:///srv/${name}`, name, fsPath: `/srv/${name}` };
}

const OK_DIR = '/srv/config/vscode-deployment/projects/-srv-good';

const OK: LoadResult = {
  status: 'ok',
  dir: OK_DIR,
  config: { version: 1, projectPath: PROJECT, servers: [sftpServer()] },
  migratedFrom: null,
};

describe('loadFolders', () => {
  it('counts a folder that fails unexpectedly as invalid and keeps loading the others', async () => {
    const load: ConfigLoader = (fsPath) => {
      if (fsPath === '/srv/broken') {
        return Promise.reject(new Error('EIO: i/o error'));
      }
      return Promise.resolve(OK);
    };
    const snapshot = await loadFolders([folder('broken'), folder('good')], OPTIONS, load);

    expect(snapshot.statuses.map((status) => status.result.status)).toEqual(['invalid', 'ok']);
    expect(snapshot.statuses[0]?.result).toEqual({
      status: 'invalid',
      dir: null,
      errors: ['could not be loaded: EIO: i/o error'],
    });
    expect(snapshot.keys).toEqual({ hasConfig: true, hasUploadTarget: true });
  });

  it('fails closed: no upload target when the only configured folder fails', async () => {
    const load: ConfigLoader = () => Promise.reject(new Error('boom'));
    const snapshot = await loadFolders([folder('broken')], OPTIONS, load);
    expect(snapshot.keys).toEqual({ hasConfig: false, hasUploadTarget: false });
  });

  it('watches the folders of missing, invalid and loaded configurations, not unsafe ones', async () => {
    const results: Record<string, LoadResult> = {
      '/srv/a': { status: 'missing', dir: '/cfg/projects/-srv-a' },
      '/srv/b': { status: 'invalid', dir: '/cfg/projects/-srv-b', errors: ['x'] },
      '/srv/c': { status: 'invalid', dir: null, errors: ['x'] },
      '/srv/d': { status: 'unsafe', problem: 'is a symbolic link' },
      '/srv/good': OK,
    };
    const load: ConfigLoader = (fsPath) => Promise.resolve(results[fsPath] ?? OK);
    const snapshot = await loadFolders(['a', 'b', 'c', 'd', 'good'].map(folder), OPTIONS, load);
    expect(snapshot.configDirs).toEqual(['/cfg/projects/-srv-a', '/cfg/projects/-srv-b', OK_DIR]);
  });
});

describe('describeProblem', () => {
  it('describes unsafe and invalid configurations only', () => {
    expect(
      describeProblem({ folder: folder('a'), result: { status: 'unsafe', problem: 'p' } }),
    ).toBe('Deployment configuration of "a" was not loaded: p.');
    expect(
      describeProblem({
        folder: folder('a'),
        result: { status: 'invalid', dir: null, errors: ['one', 'two', 'three'] },
      }),
    ).toBe('Deployment configuration of "a" is not valid: one (and 2 more).');
    expect(describeProblem({ folder: folder('a'), result: OK })).toBeNull();
  });
});

describe('NotificationDeduplicator', () => {
  it('shows a message once until it changes or the problem goes away', () => {
    const dedupe = new NotificationDeduplicator();
    expect(dedupe.shouldShow('a', 'broken')).toBe(true);
    expect(dedupe.shouldShow('a', 'broken')).toBe(false);
    expect(dedupe.shouldShow('b', 'broken')).toBe(true);
    expect(dedupe.shouldShow('a', 'broken differently')).toBe(true);
    expect(dedupe.shouldShow('a', null)).toBe(false);
    expect(dedupe.shouldShow('a', 'broken differently')).toBe(true);
  });
});

describe('watchSpec', () => {
  const dir = '/cfg/vscode-deployment/projects/-srv-app';

  it('watches the nearest existing folder with a pattern down to config.json', () => {
    expect(watchSpec(dir, () => true)).toEqual({ base: dir, pattern: 'config.json' });
    expect(watchSpec(dir, (folder) => folder !== dir)).toEqual({
      base: '/cfg/vscode-deployment/projects',
      pattern: '-srv-app/config.json',
    });
    expect(watchSpec(dir, (folder) => folder === '/cfg/vscode-deployment')).toEqual({
      base: '/cfg/vscode-deployment',
      pattern: 'projects/-srv-app/config.json',
    });
    expect(watchSpec(dir, () => false)).toBeNull();
  });

  it('never puts a name with glob characters into a pattern', () => {
    const odd = '/cfg/vscode-deployment/projects/-srv-app[1]';
    expect(watchSpec(odd, () => true)).toEqual({ base: odd, pattern: 'config.json' });
    expect(watchSpec(odd, (folder) => folder !== odd)).toBeNull();
  });
});
