import { describe, expect, it } from 'vitest';
import {
  PathOutsideRootError,
  isExcluded,
  mappingFor,
  pathSegments,
  projectRelativePath,
  remotePathOf,
} from '../../../src/mapping/paths';

describe('pathSegments', () => {
  it.each([
    ['', []],
    ['.', []],
    ['./', []],
    ['www/app', ['www', 'app']],
    ['./www//app/', ['www', 'app']],
    ['www/./app', ['www', 'app']],
  ])('splits "%s"', (path, segments) => {
    expect(pathSegments(path)).toEqual(segments);
  });
});

describe('isExcluded', () => {
  const excluded = ['.git', 'node_modules', 'var/cache', './tmp/'];

  it.each([
    ['.git/config', true],
    ['.git', true],
    ['node_modules/a/b.js', true],
    ['var/cache/x', true],
    ['tmp/a', true],
    ['var/cache2/x', false],
    ['var/log/x', false],
    ['src/.git/x', false],
    ['node_modules2/a.js', false],
  ])('%s -> %s', (path, expected) => {
    expect(isExcluded(path, excluded)).toBe(expected);
  });

  it('excludes nothing with an empty list, and everything with the base itself', () => {
    expect(isExcluded('a/b', [])).toBe(false);
    expect(isExcluded('a/b', ['.'])).toBe(true);
  });
});

describe('mappingFor', () => {
  const mappings = [
    { localPath: '.', deploymentPath: 'www/app' },
    { localPath: 'public', deploymentPath: 'www/static' },
    { localPath: 'public/assets', deploymentPath: 'cdn' },
  ];

  it('uses the mapping with the longest local path', () => {
    expect(mappingFor(mappings, 'src/a.php')?.index).toBe(0);
    expect(mappingFor(mappings, 'public/index.php')?.index).toBe(1);
    expect(mappingFor(mappings, 'public/assets/app.css')?.index).toBe(2);
    expect(mappingFor(mappings, 'publicity/a')?.index).toBe(0);
  });

  it('gives the path below the mapping', () => {
    expect(mappingFor(mappings, 'public/assets/img/a.png')?.rest).toEqual(['img', 'a.png']);
  });

  it('finds nothing outside every mapping', () => {
    expect(mappingFor([{ localPath: 'public', deploymentPath: '' }], 'src/a.php')).toBeUndefined();
    expect(mappingFor([], 'a')).toBeUndefined();
  });
});

describe('remotePathOf below the root path', () => {
  it('refuses a path that would leave the root path', () => {
    expect(() => remotePathOf('/home/deploy', 'www', ['..', '..', 'etc', 'passwd'])).toThrow(
      PathOutsideRootError,
    );
    expect(() => remotePathOf('/home/deploy', '.', ['..'])).toThrow(PathOutsideRootError);
    expect(() => remotePathOf('/home/deploy', '.', ['..deploy2'])).not.toThrow();
  });
});

describe('remotePathOf', () => {
  it('joins the root path, the deployment path and the rest', () => {
    expect(remotePathOf('/home/deploy', 'www/app', ['src', 'a.php'])).toBe(
      '/home/deploy/www/app/src/a.php',
    );
    expect(remotePathOf('/home/deploy/', '.', ['a.php'])).toBe('/home/deploy/a.php');
    expect(remotePathOf('/', '', ['a.php'])).toBe('/a.php');
  });
});

describe('projectRelativePath', () => {
  it('gives a path inside the project with forward slashes', () => {
    expect(projectRelativePath('/var/www/app', '/var/www/app/public/assets', 'linux')).toBe(
      'public/assets',
    );
    expect(projectRelativePath('/var/www/app', '/var/www/app', 'linux')).toBe('.');
    expect(projectRelativePath('C:\\work\\app', 'C:\\work\\app\\public\\x', 'win32')).toBe(
      'public/x',
    );
  });

  it('refuses a path outside the project', () => {
    expect(projectRelativePath('/var/www/app', '/var/www/app2/x', 'linux')).toBeNull();
    expect(projectRelativePath('/var/www/app', '/var/www', 'linux')).toBeNull();
    expect(projectRelativePath('/var/www/app', '/home/deploy/.ssh', 'linux')).toBeNull();
    expect(projectRelativePath('C:\\work\\app', 'D:\\work\\app\\x', 'win32')).toBeNull();
  });

  it('refuses a name with a backslash on POSIX, which the configuration cannot hold', () => {
    expect(projectRelativePath('/var/www/app', '/var/www/app/a\\b', 'linux')).toBeNull();
  });
});
