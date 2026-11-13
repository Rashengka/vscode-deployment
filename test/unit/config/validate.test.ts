import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { emptyConfig } from '../../../src/config/model';
import { validateConfig } from '../../../src/config/validate';
import { PROJECT, inplaceServer, json, sftpServer } from './fixtures';

const POSIX = { platform: 'linux' } as const;

// Assembled at run time, so that secret scanners do not flag this file. The values are fake.
const KEY_BLOCK_START = ['-----BEGIN', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ');

function urlWithCredentials(): string {
  const url = new URL('http://app.example.com/');
  url.username = 'deploy';
  url.password = randomBytes(8).toString('hex');
  return url.href;
}

function config(servers: unknown[], extra: Record<string, unknown> = {}): unknown {
  return { version: 1, projectPath: PROJECT, servers, ...extra };
}

function errorsOf(value: unknown, options: { platform: NodeJS.Platform } = POSIX): string[] {
  const result = validateConfig(value, options);
  return result.ok ? [] : [...result.errors];
}

function withServer(patch: Record<string, unknown>): unknown {
  return config([{ ...json(sftpServer()), ...patch }]);
}

function withMapping(mapping: Record<string, unknown>): unknown {
  return withServer({ mappings: [{ localPath: '.', deploymentPath: '', ...mapping }] });
}

function connectionWith(patch: Record<string, unknown>): Record<string, unknown> {
  return { ...(json(sftpServer())['connection'] as Record<string, unknown>), ...patch };
}

describe('validateConfig', () => {
  it('accepts a complete configuration with both server types', () => {
    const value = config([json(sftpServer()), json(inplaceServer())]);
    const result = validateConfig(value, POSIX);
    expect(result).toEqual({ ok: true, config: value });
  });

  it('accepts the empty configuration that Open Config creates', () => {
    expect(validateConfig(json(emptyConfig(PROJECT)), POSIX).ok).toBe(true);
  });

  it('accepts a manual connection and a Windows project path on Windows', () => {
    const manual = sftpServer({
      connection: {
        sshConfigHost: null,
        host: 'app.example.com',
        port: 2222,
        user: 'deploy',
        identityFile: '~/.ssh/id_ed25519',
        useSshAgent: true,
      },
    });
    const value = config([json(manual)], { projectPath: 'C:\\www\\app' });
    expect(errorsOf(value, { platform: 'win32' })).toEqual([]);
    expect(errorsOf(value, POSIX)).toEqual(['projectPath: must be an absolute path']);
  });

  it('rejects a non-object and missing top-level fields', () => {
    expect(errorsOf(null)).toEqual(['config: must be an object']);
    expect(errorsOf([])).toEqual(['config: must be an object']);
    expect(errorsOf({})).toEqual([
      'version: must be 1',
      'projectPath: must be a string',
      'servers: must be an array',
    ]);
  });

  describe('never carries secrets', () => {
    it.each(['password', 'passphrase', 'privateKey', 'secret'])(
      'rejects a "%s" property on the server and on the connection',
      (key) => {
        const server = json(sftpServer());
        server[key] = 'value';
        (server['connection'] as Record<string, unknown>)[key] = 'value';
        expect(errorsOf(config([server]))).toEqual([
          `servers[0].${key}: unknown property`,
          `servers[0].connection.${key}: unknown property`,
        ]);
      },
    );

    it('never quotes values or unusual property names in messages', () => {
      const marker = randomBytes(6).toString('hex');
      const server = json(sftpServer({ name: `\u0007${marker}` }));
      server[`${marker} ${marker}`] = marker;
      const errors = errorsOf(config([server]));
      expect(errors).toEqual([
        'servers[0].(property with an unusual name): unknown property',
        'servers[0].name: must not contain control characters',
      ]);
      expect(errors.join('\n')).not.toContain(marker);
    });

    it('rejects unknown properties at the top level, in mappings and on in-place servers', () => {
      const server = json(sftpServer());
      server['mappings'] = [{ localPath: '.', deploymentPath: '', extra: true }];
      expect(
        errorsOf(config([server, { ...json(inplaceServer()), mappings: [] }], { extra: 1 })),
      ).toEqual([
        'config.extra: unknown property',
        'servers[0].mappings[0].extra: unknown property',
        'servers[1].mappings: unknown property',
      ]);
    });

    it('requires useSshAgent to be true or false', () => {
      const missing = Object.fromEntries(
        Object.entries(connectionWith({})).filter(([key]) => key !== 'useSshAgent'),
      );
      expect(errorsOf(withServer({ connection: missing }))).toEqual([
        'servers[0].connection.useSshAgent: must be true or false',
      ]);
      expect(errorsOf(withServer({ connection: connectionWith({ useSshAgent: 'yes' }) }))).toEqual([
        'servers[0].connection.useSshAgent: must be true or false',
      ]);
    });

    it('rejects key material in identityFile', () => {
      const connection = connectionWith({ identityFile: `${KEY_BLOCK_START} AAAA` });
      expect(errorsOf(withServer({ connection }))).toEqual([
        'servers[0].connection.identityFile: must be a path to a key file, never the key itself',
      ]);
      // The base64 body of an OpenSSH key without its BEGIN line.
      const body = Buffer.concat([Buffer.from('openssh-key-v1\0'), randomBytes(24)]);
      const bodyOnly = connectionWith({ identityFile: body.toString('base64') });
      expect(errorsOf(withServer({ connection: bodyOnly }))).toEqual([
        'servers[0].connection.identityFile: must be a path to a key file, never the key itself',
      ]);
      const multiline = connectionWith({ identityFile: 'line1\nline2' });
      expect(errorsOf(withServer({ connection: multiline }))).toEqual([
        'servers[0].connection.identityFile: must not contain control characters',
      ]);
    });

    it('rejects credentials in the web URL of an in-place server', () => {
      const server = { ...json(inplaceServer()), webUrl: urlWithCredentials() };
      expect(errorsOf(config([server]))).toEqual([
        'servers[0].webUrl: must not contain a user name or password',
      ]);
    });
  });

  describe('server list rules', () => {
    it('requires unique names, ignoring case and surrounding spaces', () => {
      const value = config([
        json(sftpServer({ id: 'one', name: 'Production', default: false })),
        json(sftpServer({ id: 'two', name: ' production ', default: false })),
      ]);
      expect(errorsOf(value)).toEqual(['servers[1].name: is already used by servers[0]']);
    });

    it('requires unique ids', () => {
      const value = config([
        json(sftpServer({ id: 'same', name: 'A', default: false })),
        json(inplaceServer({ id: 'same', name: 'B' })),
      ]);
      expect(errorsOf(value)).toEqual(['servers[1].id: is already used by servers[0]']);
    });

    it('allows no default and at most one default', () => {
      const none = config([json(sftpServer({ default: false }))]);
      expect(errorsOf(none)).toEqual([]);
      const two = config([
        json(sftpServer({ id: 'one', name: 'A', default: true })),
        json(inplaceServer({ id: 'two', name: 'B', default: true })),
      ]);
      expect(errorsOf(two)).toEqual(['servers: at most one server may be the default (found 2)']);
    });

    it('rejects an unknown server type and empty names', () => {
      expect(errorsOf(config([{ ...json(sftpServer()), type: 'ftp' }]))).toEqual([
        'servers[0].type: must be "sftp" or "inplace"',
      ]);
      expect(errorsOf(withServer({ name: '   ' }))).toEqual(['servers[0].name: must not be empty']);
    });
  });

  describe('deploymentPath stays under rootPath', () => {
    it.each(['', '.', 'www', 'www/app.example.com', 'www/./app', 'www/..app', 'a..b'])(
      'accepts %j',
      (deploymentPath) => {
        expect(errorsOf(withMapping({ deploymentPath }))).toEqual([]);
      },
    );

    it.each([
      ['/www', 'must be a relative path'],
      ['C:/www', 'must be a relative path'],
      ['..', 'must not contain ".."'],
      ['www/../..', 'must not contain ".."'],
      ['www/..', 'must not contain ".."'],
      ['www\\..\\..', 'must use forward slashes'],
      ['www\u0000', 'must not contain control characters'],
      ['www\napp', 'must not contain control characters'],
      ['www\u001b[31m', 'must not contain control characters'],
      ['www\u0085', 'must not contain control characters'],
    ])('rejects %j (%s)', (deploymentPath, message) => {
      expect(errorsOf(withMapping({ deploymentPath }))).toEqual([
        `servers[0].mappings[0].deploymentPath: ${message}`,
      ]);
    });
  });

  describe('localPath stays inside the project', () => {
    it.each([
      ['../other', 'must not contain ".."'],
      ['/etc', 'must be a relative path'],
      ['C:/Windows', 'must be a relative path'],
      ['src\\app', 'must use forward slashes'],
    ])('rejects %j', (localPath, message) => {
      expect(errorsOf(withMapping({ localPath }))).toEqual([
        `servers[0].mappings[0].localPath: ${message}`,
      ]);
    });

    it('applies the same rules to excluded paths', () => {
      expect(
        errorsOf(withServer({ excludedLocalPaths: ['../x'], excludedRemotePaths: ['/abs'] })),
      ).toEqual([
        'servers[0].excludedLocalPaths[0]: must not contain ".."',
        'servers[0].excludedRemotePaths[0]: must be a relative path',
      ]);
    });
  });

  describe('rootPath is an absolute POSIX path', () => {
    it.each([
      ['home/deploy', 'must be an absolute path on the server (starting with "/")'],
      ['C:\\deploy', 'must be an absolute path on the server (starting with "/")'],
      ['/home/deploy/../root', 'must not contain ".."'],
      ['/home\\deploy', 'must use forward slashes'],
      ['/home/deploy\u0000', 'must not contain control characters'],
      ['', 'must not be empty'],
    ])('rejects %j', (rootPath, message) => {
      expect(errorsOf(withServer({ rootPath }))).toEqual([`servers[0].rootPath: ${message}`]);
    });
  });

  describe('connection and numbers', () => {
    it('needs exactly one of an SSH config alias and a host', () => {
      for (const connection of [
        connectionWith({ sshConfigHost: null, host: null }),
        connectionWith({ sshConfigHost: 'app', host: 'app.example.com' }),
      ]) {
        expect(errorsOf(withServer({ connection }))).toEqual([
          'servers[0].connection: needs exactly one of "sshConfigHost" and "host"',
        ]);
      }
    });

    it('rejects a user name with ":" (user:password)', () => {
      const connection = connectionWith({ user: 'deploy:x' });
      expect(errorsOf(withServer({ connection }))).toEqual([
        'servers[0].connection.user: must not contain ":"',
      ]);
    });

    it.each([0, 65_536, 22.5, '22'])('rejects port %j', (port) => {
      const connection = connectionWith({ port });
      expect(errorsOf(withServer({ connection }))).toEqual([
        'servers[0].connection.port: must be a whole number from 1 to 65535',
      ]);
    });

    it('limits keep-alive and idle disconnect', () => {
      expect(errorsOf(withServer({ keepAliveSeconds: -1, idleDisconnectMinutes: 1.5 }))).toEqual([
        'servers[0].keepAliveSeconds: must be a whole number from 0 to 86400',
        'servers[0].idleDisconnectMinutes: must be a whole number from 0 to 10080',
      ]);
    });
  });

  describe('in-place server', () => {
    it('needs an absolute folder', () => {
      expect(errorsOf(config([{ ...json(inplaceServer()), folder: 'www/app' }]))).toEqual([
        'servers[0].folder: must be an absolute path',
      ]);
    });

    it('accepts a null web URL and rejects other schemes', () => {
      expect(errorsOf(config([{ ...json(inplaceServer()), webUrl: null }]))).toEqual([]);
      expect(
        errorsOf(config([{ ...json(inplaceServer()), webUrl: 'javascript:alert(1)' }])),
      ).toEqual(['servers[0].webUrl: must be an http or https URL']);
      expect(errorsOf(config([{ ...json(inplaceServer()), webUrl: 'not a url' }]))).toEqual([
        'servers[0].webUrl: must be a valid URL',
      ]);
    });
  });
});
