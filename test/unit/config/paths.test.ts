import { describe, expect, it } from 'vitest';
import {
  CONFIG_DIR_ENV,
  configRoot,
  disambiguatedName,
  encodeProjectPath,
  projectsDir,
} from '../../../src/config/paths';

describe('encodeProjectPath', () => {
  it.each([
    ['/var/www/app', '-var-www-app'],
    ['/home/deploy/my project', '-home-deploy-my project'],
    ['/', '-'],
    ['C:\\www\\app', 'C--www-app'],
    ['c:\\x', 'c--x'],
    ['D:\\', 'D--'],
    ['\\\\server\\share\\app', '--server-share-app'],
    ['/var/www/a\nb\u0000c', '-var-www-a-b-c'],
  ])('encodes %j as %j', (input, expected) => {
    expect(encodeProjectPath(input)).toBe(expected);
  });

  it('maps different paths to the same name (the reason for the stored projectPath)', () => {
    expect(encodeProjectPath('/var/www-app')).toBe(encodeProjectPath('/var/www/app'));
  });

  it('shortens very long paths and keeps them unique with a hash', () => {
    const long = `/var/www/${'x'.repeat(300)}`;
    const other = `/var/www/${'x'.repeat(299)}y`;
    const encoded = encodeProjectPath(long);
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(160);
    expect(encoded).toMatch(/^-var-www-x+-[0-9a-f]{16}$/);
    expect(encodeProjectPath(other)).not.toBe(encoded);
  });

  it('never splits a multi-byte character when shortening', () => {
    const encoded = encodeProjectPath(`/var/${'ž'.repeat(200)}`);
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(160);
    expect(encoded).not.toContain('\uFFFD');
    expect(encoded).toMatch(/^-var-ž+-[0-9a-f]{16}$/);
  });
});

describe('disambiguatedName', () => {
  it('adds a stable hash of the full path', () => {
    const name = disambiguatedName('/var/www-app');
    expect(name).toMatch(/^-var-www-app-[0-9a-f]{16}$/);
    expect(disambiguatedName('/var/www-app')).toBe(name);
    expect(disambiguatedName('/var/www/app')).not.toBe(name);
  });

  it('differs from the encoded name even for shortened paths', () => {
    const long = `/var/www/${'x'.repeat(300)}`;
    expect(disambiguatedName(long)).not.toBe(encodeProjectPath(long));
  });
});

describe('configRoot', () => {
  it('uses ~/.config on POSIX by default', () => {
    expect(configRoot({ platform: 'linux', env: {}, homedir: '/home/deploy' })).toBe(
      '/home/deploy/.config/vscode-deployment',
    );
    expect(configRoot({ platform: 'darwin', env: {}, homedir: '/home/deploy' })).toBe(
      '/home/deploy/.config/vscode-deployment',
    );
  });

  it('follows an absolute XDG_CONFIG_HOME and ignores a relative one', () => {
    expect(
      configRoot({
        platform: 'linux',
        env: { XDG_CONFIG_HOME: '/srv/config' },
        homedir: '/home/deploy',
      }),
    ).toBe('/srv/config/vscode-deployment');
    expect(
      configRoot({
        platform: 'linux',
        env: { XDG_CONFIG_HOME: 'config' },
        homedir: '/home/deploy',
      }),
    ).toBe('/home/deploy/.config/vscode-deployment');
  });

  it('uses %APPDATA% on Windows', () => {
    expect(
      configRoot({
        platform: 'win32',
        env: { APPDATA: 'C:\\Profiles\\deploy\\AppData\\Roaming' },
        homedir: 'C:\\Profiles\\deploy',
      }),
    ).toBe('C:\\Profiles\\deploy\\AppData\\Roaming\\vscode-deployment');
    expect(configRoot({ platform: 'win32', env: {}, homedir: 'C:\\Profiles\\deploy' })).toBe(
      'C:\\Profiles\\deploy\\AppData\\Roaming\\vscode-deployment',
    );
  });

  it('can be overridden with an absolute path only', () => {
    expect(
      configRoot({
        platform: 'linux',
        env: { [CONFIG_DIR_ENV]: '/srv/test-config/' },
        homedir: '/home/deploy',
      }),
    ).toBe('/srv/test-config/');
    expect(() =>
      configRoot({ platform: 'linux', env: { [CONFIG_DIR_ENV]: 'relative' }, homedir: '/' }),
    ).toThrow(CONFIG_DIR_ENV);
  });

  it('puts project folders under projects/', () => {
    expect(projectsDir('/srv/config/vscode-deployment', 'linux')).toBe(
      '/srv/config/vscode-deployment/projects',
    );
    expect(projectsDir('C:\\cfg\\vscode-deployment', 'win32')).toBe(
      'C:\\cfg\\vscode-deployment\\projects',
    );
  });
});
