import { describe, expect, it } from 'vitest';
import { PathOutsideRootError } from '../../../src/mapping/paths';
import { localFileTarget, remoteTargetOf } from '../../../src/mapping/target';
import { sftpServer } from '../../support/connectionFixture';

const server = sftpServer('prod', 'test', {
  rootPath: '/home/deploy',
  mappings: [
    { localPath: '.', deploymentPath: 'www/app' },
    { localPath: 'public', deploymentPath: 'www/public' },
  ],
  excludedLocalPaths: ['.git', 'var/cache'],
  excludedRemotePaths: ['www/app/uploads'],
});

describe('localFileTarget', () => {
  it('maps a project file by the mapping with the longest local path', () => {
    expect(localFileTarget(server, '/var/www/app', '/var/www/app/src/a.php', 'linux')).toEqual({
      kind: 'ok',
      localRelative: 'src/a.php',
      mappingIndex: 0,
      remotePath: '/home/deploy/www/app/src/a.php',
    });
    expect(
      localFileTarget(server, '/var/www/app', '/var/www/app/public/index.php', 'linux'),
    ).toEqual({
      kind: 'ok',
      localRelative: 'public/index.php',
      mappingIndex: 1,
      remotePath: '/home/deploy/www/public/index.php',
    });
  });

  it('refuses a file outside the project folder', () => {
    expect(localFileTarget(server, '/var/www/app', '/var/www/other/a.php', 'linux')).toEqual({
      kind: 'outside',
    });
    expect(localFileTarget(server, '/var/www/app', '/var/www/app', 'linux')).toEqual({
      kind: 'outside',
    });
  });

  it('refuses a file no mapping covers', () => {
    const narrow = { ...server, mappings: [{ localPath: 'src', deploymentPath: 'www/app' }] };
    expect(localFileTarget(narrow, '/var/www/app', '/var/www/app/README.md', 'linux')).toEqual({
      kind: 'unmapped',
    });
  });

  it('refuses a file excluded locally or on the server', () => {
    expect(
      localFileTarget(server, '/var/www/app', '/var/www/app/var/cache/x.php', 'linux'),
    ).toEqual({ kind: 'excluded' });
    expect(localFileTarget(server, '/var/www/app', '/var/www/app/.git/config', 'linux')).toEqual({
      kind: 'excluded',
    });
    expect(localFileTarget(server, '/var/www/app', '/var/www/app/uploads/a.png', 'linux')).toEqual({
      kind: 'excluded',
    });
  });

  it('handles Windows paths', () => {
    expect(localFileTarget(server, 'C:\\work\\app', 'C:\\work\\app\\src\\a.php', 'win32')).toEqual({
      kind: 'ok',
      localRelative: 'src/a.php',
      mappingIndex: 0,
      remotePath: '/home/deploy/www/app/src/a.php',
    });
  });

  it('reports a path that would leave the root path instead of throwing', () => {
    const escaping = { ...server, mappings: [{ localPath: '.', deploymentPath: '../../etc' }] };
    expect(localFileTarget(escaping, '/var/www/app', '/var/www/app/passwd', 'linux')).toEqual({
      kind: 'outsideRoot',
    });
  });
});

describe('remoteTargetOf', () => {
  it('names the mapping of a mapped, excluded or deployable project file', () => {
    expect(remoteTargetOf(server, 'src/a.php')).toEqual({
      kind: 'ok',
      mappingIndex: 0,
      remotePath: '/home/deploy/www/app/src/a.php',
    });
    expect(remoteTargetOf(server, 'var/cache/x')).toEqual({ kind: 'excluded', mappingIndex: 0 });
    expect(remoteTargetOf(server, 'uploads/a.png')).toEqual({ kind: 'excluded', mappingIndex: 0 });
    const narrow = { ...server, mappings: [{ localPath: 'src', deploymentPath: 'www/app' }] };
    expect(remoteTargetOf(narrow, 'README.md')).toEqual({ kind: 'unmapped' });
  });

  it('throws for a path that would leave the root path, like remotePathOf', () => {
    const escaping = { ...server, mappings: [{ localPath: '.', deploymentPath: '../../etc' }] };
    expect(() => remoteTargetOf(escaping, 'passwd')).toThrow(PathOutsideRootError);
  });
});
