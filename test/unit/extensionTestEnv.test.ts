import { describe, expect, it } from 'vitest';
import {
  effectiveVariableNames,
  extensionTestEnvironment,
} from '../../scripts/lib/extensionTestEnv.mts';

const DIRS = { home: '/tmp/instance/h', xdg: '/tmp/instance/x' };
/** Stands in for the value of any variable; the tests are about names only. */
const SOME_VALUE = 'value';

describe('extensionTestEnvironment', () => {
  it('removes every variable that is not on the allowlist', () => {
    const parent = {
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8',
      GITHUB_TOKEN: SOME_VALUE,
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      NODE_OPTIONS: '--require=/tmp/x.js',
      AWS_SECRET_ACCESS_KEY: SOME_VALUE,
      ELECTRON_RUN_AS_NODE: '1',
    };

    const env = extensionTestEnvironment(parent, 'linux', DIRS, {});

    expect(env['GITHUB_TOKEN']).toBeUndefined();
    expect(env['SSH_AUTH_SOCK']).toBeUndefined();
    expect(env['NODE_OPTIONS']).toBeUndefined();
    expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
    expect(env['ELECTRON_RUN_AS_NODE']).toBeUndefined();
    // The keys exist (with undefined) so that they override the parent's values.
    expect(Object.keys(env)).toContain('GITHUB_TOKEN');
    expect(effectiveVariableNames(parent, env).sort()).toEqual(
      [
        'HOME',
        'LANG',
        'PATH',
        'XDG_CACHE_HOME',
        'XDG_CONFIG_HOME',
        'XDG_DATA_HOME',
        'XDG_STATE_HOME',
      ].sort(),
    );
  });

  it('points the home and XDG folders at the instance', () => {
    const env = extensionTestEnvironment(
      { HOME: '/home/someone', XDG_CONFIG_HOME: '/home/someone/.config' },
      'darwin',
      DIRS,
      {},
    );

    expect(env['HOME']).toBe('/tmp/instance/h');
    expect(env['XDG_CONFIG_HOME']).toBe('/tmp/instance/x/config');
    expect(env['XDG_DATA_HOME']).toBe('/tmp/instance/x/data');
    expect(env['XDG_CACHE_HOME']).toBe('/tmp/instance/x/cache');
    expect(env['XDG_STATE_HOME']).toBe('/tmp/instance/x/state');
  });

  it('adds the variables of the test', () => {
    const env = extensionTestEnvironment({ PATH: '/usr/bin' }, 'linux', DIRS, {
      VSCODE_DEPLOYMENT_CONFIG_DIR: '/tmp/instance/cfg',
    });

    expect(env['VSCODE_DEPLOYMENT_CONFIG_DIR']).toBe('/tmp/instance/cfg');
    expect(env['PATH']).toBe('/usr/bin');
  });

  it('compares names without regard to case on Windows', () => {
    const parent = {
      Path: 'C:\\Windows',
      SystemRoot: 'C:\\Windows',
      UserProfile: 'C:\\Users\\someone',
      GitHub_Token: SOME_VALUE,
    };

    const env = extensionTestEnvironment(parent, 'win32', DIRS, {});

    expect(env['Path']).toBe('C:\\Windows');
    expect(env['GitHub_Token']).toBeUndefined();
    expect(env['UserProfile']).toBeUndefined();
    expect(env['USERPROFILE']).toBe('/tmp/instance/h');
    expect(env['APPDATA']).toBe('/tmp/instance/x\\AppData\\Roaming');
  });

  it('keeps case-sensitive names apart elsewhere', () => {
    const env = extensionTestEnvironment({ path: '/tmp/x', PATH: '/usr/bin' }, 'linux', DIRS, {});

    expect(env['path']).toBeUndefined();
    expect(env['PATH']).toBe('/usr/bin');
  });
});
