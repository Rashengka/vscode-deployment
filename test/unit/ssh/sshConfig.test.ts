import { describe, expect, it } from 'vitest';
import {
  listSshHostAliases,
  MAX_CONFIG_FILE_BYTES,
  MAX_CONFIG_FILES,
  resolveSshHost,
  SshConfigError,
  type SshConfigEnvironment,
} from '../../../src/ssh/sshConfig';

const HOME = '/home/deploy';
const CONFIG = `${HOME}/.ssh/config`;

/** An in-memory file system: nothing here touches the disk or the real ~/.ssh. */
function environment(
  files: Record<string, string>,
  extra: Partial<SshConfigEnvironment> = {},
): SshConfigEnvironment & { readonly reads: string[] } {
  const reads: string[] = [];
  return {
    homeDirectory: HOME,
    localUser: 'deploy',
    platform: 'posix',
    reads,
    readFile: (path) => {
      reads.push(path);
      return Promise.resolve(files[path]);
    },
    listDirectory: (path) => {
      const prefix = path.endsWith('/') ? path : `${path}/`;
      const names = Object.keys(files)
        .filter((file) => file.startsWith(prefix))
        .map((file) => file.slice(prefix.length).split('/')[0] ?? '');
      return Promise.resolve(names.length === 0 ? undefined : [...new Set(names)]);
    },
    ...extra,
  };
}

function resolve(alias: string, config: string, files: Record<string, string> = {}) {
  return resolveSshHost(alias, environment({ [CONFIG]: config, ...files }));
}

async function errorOf(promise: Promise<unknown>): Promise<SshConfigError> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof SshConfigError)) {
    throw new Error(`Expected an SshConfigError, got ${String(error)}`);
  }
  return error;
}

function resolveError(
  alias: string,
  config: string,
  files: Record<string, string> = {},
): Promise<SshConfigError> {
  return errorOf(resolve(alias, config, files));
}

const lines = (...text: string[]): string => text.join('\n');

describe('resolveSshHost', () => {
  it('uses OpenSSH defaults without a config file', async () => {
    const env = environment({});
    const host = await resolveSshHost('example.com', env);
    expect(host).toEqual({
      alias: 'example.com',
      hostName: 'example.com',
      port: 22,
      user: 'deploy',
      identityFiles: [`${HOME}/.ssh/id_ed25519`, `${HOME}/.ssh/id_ecdsa`, `${HOME}/.ssh/id_rsa`],
      identityFilesAreDefaults: true,
      identitiesOnly: false,
      identityAgent: undefined,
      userKnownHostsFiles: [`${HOME}/.ssh/known_hosts`, `${HOME}/.ssh/known_hosts2`],
      globalKnownHostsFiles: ['/etc/ssh/ssh_known_hosts', '/etc/ssh/ssh_known_hosts2'],
      hostKeyAlias: undefined,
      knownHostsName: 'example.com',
    });
    // The system file is read by default, after the user file.
    expect(env.reads).toEqual([CONFIG, '/etc/ssh/ssh_config']);
  });

  it('resolves HostName, User, Port and IdentitiesOnly; the first obtained value wins', async () => {
    const host = await resolve(
      'production',
      lines(
        '# comment',
        'Host production',
        '  HostName app.example.com',
        '  User deploy-app',
        '  Port 2222',
        '  IdentitiesOnly yes',
        '',
        'Host *',
        '  HostName ignored.example.com',
        '  User ignored',
        '  Port 22',
        '  IdentitiesOnly no',
        '  StrictHostKeyChecking no',
      ),
    );
    expect(host).toMatchObject({
      hostName: 'app.example.com',
      user: 'deploy-app',
      port: 2222,
      identitiesOnly: true,
      knownHostsName: '[app.example.com]:2222',
    });
  });

  it('accepts Keyword=value, quoted values, case-insensitive keywords and inline comments', async () => {
    const host = await resolve(
      'web',
      lines(
        'HOST=web',
        '  hostname = "app.example.com" # trailing comment',
        '\tIdentityFile "~/.ssh/key with space"',
        '  User = it\\ works',
      ),
    );
    expect(host.hostName).toBe('app.example.com');
    expect(host.identityFiles).toEqual([`${HOME}/.ssh/key with space`]);
    expect(host.user).toBe('it works');
  });

  it('matches Host patterns with wildcards and negation', async () => {
    const config = lines(
      'Host *.example.com !staging.example.com',
      '  User web',
      'Host app?',
      '  User numbered',
      'Host !* nothing',
      '  User never',
    );
    expect((await resolve('www.example.com', config)).user).toBe('web');
    expect((await resolve('staging.example.com', config)).user).toBe('deploy');
    expect((await resolve('app1', config)).user).toBe('numbered');
    expect((await resolve('app12', config)).user).toBe('deploy');
    expect((await resolve('nothing', config)).user).toBe('deploy');
  });

  it('matches Host patterns case-sensitively, like OpenSSH', async () => {
    const config = lines('Host Production', '  User upper', 'Host production', '  User lower');
    expect((await resolve('Production', config)).user).toBe('upper');
    expect((await resolve('production', config)).user).toBe('lower');
    expect((await resolve('PRODUCTION', config)).user).toBe('deploy');
  });

  it('lower-cases host names and HostKeyAlias but not IP addresses, like OpenSSH', async () => {
    const upper = await resolve('Web', lines('Host Web', '  HostKeyAlias Web-Key'));
    expect(upper).toMatchObject({
      alias: 'Web',
      hostName: 'web',
      hostKeyAlias: 'web-key',
      knownHostsName: 'web-key',
    });
    const ipv6 = await resolve('v6', lines('Host v6', '  HostName 2001:DB8::1'));
    expect(ipv6.hostName).toBe('2001:DB8::1');
    expect(ipv6.knownHostsName).toBe('2001:db8::1');
  });

  it('collects every IdentityFile in order and expands tokens', async () => {
    const host = await resolve(
      'production',
      lines(
        'Host production',
        '  HostName app.example.com',
        '  User www',
        '  Port 2200',
        '  IdentityFile ~/.ssh/id_%h_%r',
        '  IdentityFile %d/.ssh/%u-%n-%p%%',
        'Host *',
        '  IdentityFile /var/www/app/key',
        '  IdentityFile2 ~/.ssh/id_app.example.com_www',
      ),
    );
    expect(host.identityFiles).toEqual([
      `${HOME}/.ssh/id_app.example.com_www`,
      `${HOME}/.ssh/deploy-production-2200%`,
      '/var/www/app/key',
    ]);
    expect(host.identityFilesAreDefaults).toBe(false);
  });

  it('treats IdentityFile none as no identity files', async () => {
    const host = await resolve('a', 'IdentityFile none');
    expect(host.identityFiles).toEqual([]);
    expect(host.identityFilesAreDefaults).toBe(false);
  });

  it.each([
    ['IdentityAgent none', 'none'],
    ['IdentityAgent SSH_AUTH_SOCK', 'SSH_AUTH_SOCK'],
    ['IdentityAgent ~/.ssh/agent-%n.sock', `${HOME}/.ssh/agent-a.sock`],
  ])('exposes %s', async (config, expected) => {
    expect((await resolve('a', config)).identityAgent).toBe(expected);
  });

  it.each([
    ['IdentityFile ~/.ssh/%C', 'IdentityFile', /%C/],
    ['IdentityFile ~/.ssh/%l', 'IdentityFile', /%l/],
    ['IdentityFile ${HOME}/.ssh/key', 'IdentityFile', /environment variables/],
    ['IdentityFile relative/key', 'IdentityFile', /relative path/],
    ['IdentityFile ~other/.ssh/key', 'IdentityFile', /~user/],
    ['IdentityAgent $AGENT', 'IdentityAgent', /environment variables/],
    ['HostName %n.example.com', 'HostName', /%n/],
    ['HostName ..', 'HostName', /not a valid host name/],
    ['HostName ../../tmp', 'HostName', /not a valid host name/],
    ['HostName [2001:db8::1]', 'HostName', /not a valid host name/],
    ['HostName app:example', 'HostName', /not a valid host name/],
    ['Port 70000', 'Port', /not a valid port/],
    ['Port 22abc', 'Port', /not a valid port/],
    ['IdentitiesOnly maybe', 'IdentitiesOnly', /yes or no/],
    ['UserKnownHostsFile none', 'UserKnownHostsFile', /disable host key checking/],
    ['UserKnownHostsFile ~/.ssh/known_hosts /dev/null', 'UserKnownHostsFile', /null device/],
    ['UserKnownHostsFile /dev//null', 'UserKnownHostsFile', /null device/],
    ['UserKnownHostsFile %d/../../dev/null', 'UserKnownHostsFile', /null device/],
    ['GlobalKnownHostsFile /var/www/app/kh none', 'GlobalKnownHostsFile', /must appear alone/],
    ['User ../x\nIdentityFile ~/.ssh/%r', 'IdentityFile', /%r cannot be used in a path/],
    ['User ..\nUserKnownHostsFile ~/.ssh/%r', 'UserKnownHostsFile', /%r cannot be used/],
  ])('rejects %j', async (config, directive, message) => {
    const error = await resolveError('a', config);
    expect(error.directive).toBe(directive);
    expect(error.message).toMatch(message);
    expect(error.file).toBe(CONFIG);
  });

  it('resolves UserKnownHostsFile, GlobalKnownHostsFile and HostKeyAlias', async () => {
    const host = await resolve(
      'production',
      lines(
        'Host production',
        '  HostName app.example.com',
        '  Port 2222',
        '  HostKeyAlias app-alias',
        '  UserKnownHostsFile ~/.ssh/known_hosts.d/%k /var/www/app/known_hosts',
        '  GlobalKnownHostsFile none',
      ),
    );
    expect(host.hostKeyAlias).toBe('app-alias');
    // With HostKeyAlias, OpenSSH looks up the alias as is, without the port.
    expect(host.knownHostsName).toBe('app-alias');
    expect(host.userKnownHostsFiles).toEqual([
      `${HOME}/.ssh/known_hosts.d/app-alias`,
      '/var/www/app/known_hosts',
    ]);
    expect(host.globalKnownHostsFiles).toEqual([]);
  });

  it('drops a null device from the global known hosts files', async () => {
    const host = await resolve('a', 'GlobalKnownHostsFile /dev/null /var/www/app/kh');
    expect(host.globalKnownHostsFiles).toEqual(['/var/www/app/kh']);
  });

  describe('aliases and host names are safe in paths', () => {
    it.each(['', '-oProxyCommand=x', 'two words', 'a,b', 'a%h', '.', '..', '../../tmp/evil'])(
      'rejects the alias %j',
      async (alias) => {
        await expect(resolveSshHost(alias, environment({}))).rejects.toThrow(SshConfigError);
      },
    );

    it.each(['a/b', 'a\\b', '[2001:db8::1]', 'host:22', 'app@example.com'])(
      'rejects the alias %j',
      async (alias) => {
        await expect(resolveSshHost(alias, environment({}))).rejects.toThrow(SshConfigError);
      },
    );

    it('accepts IPv6 and IPv4 addresses as aliases', async () => {
      expect((await resolveSshHost('2001:db8::1', environment({}))).hostName).toBe('2001:db8::1');
      expect((await resolveSshHost('192.0.2.1', environment({}))).hostName).toBe('192.0.2.1');
    });

    it('never lets the alias escape a known hosts path', async () => {
      const error = await errorOf(
        resolveSshHost(
          '../../tmp/evil',
          environment({ [CONFIG]: 'UserKnownHostsFile ~/.ssh/kh/%n' }),
        ),
      );
      expect(error.message).toMatch(/not a valid host alias/);
    });

    it('validates a HostName derived from the alias', async () => {
      expect((await resolveError('a', 'HostName %h/x')).directive).toBe('HostName');
      expect((await resolveError('a', 'HostName %h:x')).directive).toBe('HostName');
    });
  });

  describe('directive names', () => {
    it.each([
      ['"ProxyCommand" nc %h %p', 'ProxyCommand'],
      ['Proxy"Jump" bastion.example.com', 'ProxyJump'],
      ['"Match" all', 'Match'],
    ])('reads the quoted keyword in %j like OpenSSH', async (line, directive) => {
      expect((await resolveError('a', line)).directive).toBe(directive);
    });

    it('reads a quoted Include keyword like OpenSSH', async () => {
      const host = await resolve('a', '"Include" extra', { [`${HOME}/.ssh/extra`]: 'User inc' });
      expect(host.user).toBe('inc');
    });

    it('rejects an unterminated quote in a keyword', async () => {
      expect((await resolveError('a', '"ProxyCommand nc')).message).toMatch(/Unterminated/);
    });

    it('rejects a keyword without an argument', async () => {
      expect((await resolveError('a', 'User')).message).toMatch(/No argument/);
    });

    it('rejects unknown directives in any block, like OpenSSH', async () => {
      const error = await resolveError('a', lines('Host other', '  Frobnicate yes'));
      expect(error.directive).toBe('frobnicate');
      expect(error.message).toMatch(/Bad configuration option/);
      expect(error.line).toBe(2);
    });

    it('honours an earlier applicable IgnoreUnknown', async () => {
      const config = lines('IgnoreUnknown Frob*,UseKeychain', 'UseKeychain yes', 'Frobnicate 1');
      await expect(resolve('a', config)).resolves.toMatchObject({ hostName: 'a' });
      // Not yet in effect, or set in a block that does not apply.
      expect((await resolveError('a', lines('UseKeychain yes', 'IgnoreUnknown *'))).line).toBe(1);
      const inactive = lines('Host other', '  IgnoreUnknown *', 'Host *', '  UseKeychain yes');
      expect((await resolveError('a', inactive)).directive).toBe('usekeychain');
    });

    it('ignores known OpenSSH options that do not affect the connection', async () => {
      const config = lines(
        'BindAddress 192.0.2.1',
        'AddressFamily inet',
        'ServerAliveInterval 30',
        'StrictHostKeyChecking no',
        'HostKeyAlgorithms ssh-ed25519',
      );
      await expect(resolve('a', config)).resolves.toMatchObject({ hostName: 'a' });
    });
  });

  describe('unsupported directives', () => {
    it.each([
      ['ProxyJump bastion.example.com', 'ProxyJump'],
      ['ProxyCommand nc %h %p', 'ProxyCommand'],
      ['KnownHostsCommand /bin/true', 'KnownHostsCommand'],
      ['LocalCommand echo hi', 'LocalCommand'],
      ['PKCS11Provider /usr/lib/p11.so', 'PKCS11Provider'],
      ['SmartcardDevice /usr/lib/p11.so', 'SmartcardDevice'],
      ['CertificateFile ~/.ssh/id_ed25519-cert.pub', 'CertificateFile'],
      ['RevokedHostKeys ~/.ssh/revoked', 'RevokedHostKeys'],
      ['CanonicalizeHostname yes', 'CanonicalizeHostname'],
      ['RefuseConnection yes', 'RefuseConnection'],
      ['ProxyCommand none extra', 'ProxyCommand'],
    ])('rejects %s when it applies to the host', async (directive, name) => {
      const error = await resolveError('production', lines('Host production', `  ${directive}`));
      expect(error.directive).toBe(name);
      expect(error.message).toContain(`${name} is not supported`);
      expect(error.line).toBe(2);
    });

    it('ignores them in blocks that do not apply', async () => {
      const host = await resolve(
        'production',
        lines('Host other', '  ProxyJump bastion.example.com', '  ProxyCommand nc %h %p'),
      );
      expect(host.hostName).toBe('production');
    });

    it('allows values that leave them unset', async () => {
      const host = await resolve(
        'production',
        lines(
          'Host production',
          '  ProxyJump none',
          '  ProxyCommand none',
          '  CertificateFile none',
          '  RevokedHostKeys none',
          '  CanonicalizeHostname no',
          '  RefuseConnection no',
        ),
      );
      expect(host.hostName).toBe('production');
    });

    it('does not let an earlier none hide a later value', async () => {
      const config = lines('Host production', '  ProxyJump none', 'Host *', '  ProxyCommand nc');
      expect((await resolveError('production', config)).directive).toBe('ProxyCommand');
      const again = lines('ProxyJump none', 'ProxyJump bastion.example.com');
      expect((await resolveError('production', again)).directive).toBe('ProxyJump');
    });
  });

  describe('Match', () => {
    it.each([
      ['an applicable block', lines('Match host *', '  User x')],
      ['a block for another host', lines('Host production', 'Match host other.example.com')],
      ['a block with exec', 'Match exec "touch /var/www/app/should-never-run"'],
      ['a final block', 'Match final host real.example.com'],
      ['a block inside an inactive Host block', lines('Host other', 'Match all')],
    ])('is always an error: %s', async (_name, config) => {
      const error = await resolveError('production', config);
      expect(error.directive).toBe('Match');
      expect(error.message).toMatch(/Match blocks are not supported/);
      expect(error.file).toBe(CONFIG);
    });

    it('is an error in an included file read from an inactive block', async () => {
      const error = await resolveError('production', lines('Host other', '  Include more'), {
        [`${HOME}/.ssh/more`]: lines('Host *', '  User x', 'Match all'),
      });
      expect(error.directive).toBe('Match');
      expect(error.file).toBe(`${HOME}/.ssh/more`);
      expect(error.line).toBe(3);
    });

    it('is an error in the system file', async () => {
      const env = environment({ '/etc/ssh/ssh_config': 'Match user root' });
      expect((await errorOf(resolveSshHost('a', env))).file).toBe('/etc/ssh/ssh_config');
    });
  });

  describe('Include', () => {
    it('reads files relative to ~/.ssh, expands globs in order and skips dot files', async () => {
      const env = environment({
        [CONFIG]: lines('Include config.d/*.conf', 'Host *', '  User fallback'),
        [`${HOME}/.ssh/config.d/20-b.conf`]: 'Host production\n  Port 2222',
        [`${HOME}/.ssh/config.d/10-a.conf`]: 'Host production\n  HostName app.example.com',
        [`${HOME}/.ssh/config.d/.hidden.conf`]: 'Host production\n  User hidden',
        [`${HOME}/.ssh/config.d/notes.txt`]: 'Host production\n  User notes',
        [`${HOME}/.ssh/config.d/upper.CONF`]: 'Host production\n  User upper',
      });
      const host = await resolveSshHost('production', env);
      expect(host).toMatchObject({ hostName: 'app.example.com', port: 2222, user: 'fallback' });
      // Globs are case-sensitive: upper.CONF does not match *.conf.
      expect(env.reads).toEqual([
        CONFIG,
        `${HOME}/.ssh/config.d/10-a.conf`,
        `${HOME}/.ssh/config.d/20-b.conf`,
        '/etc/ssh/ssh_config',
      ]);
    });

    it('resolves a relative Include in an included file against ~/.ssh, not that file', async () => {
      const host = await resolve('a', 'Include /var/www/app/ssh_config', {
        '/var/www/app/ssh_config': 'Include nested',
        '/var/www/app/nested': 'User wrong',
        [`${HOME}/.ssh/nested`]: 'User right',
      });
      expect(host.user).toBe('right');
    });

    it('supports ~, absolute paths, several files per line and missing files', async () => {
      const host = await resolve('production', 'Include ~/.ssh/a /var/www/app/ssh_config missing', {
        [`${HOME}/.ssh/a`]: 'Host production\n  User from-a',
        '/var/www/app/ssh_config': 'Host production\n  HostName app.example.com',
      });
      expect(host).toMatchObject({ user: 'from-a', hostName: 'app.example.com' });
    });

    it('applies an Include inside a Host block only to that host', async () => {
      const config = lines(
        'Host production',
        '  Include prod',
        '  Port 2222',
        'Host *',
        '  User fallback',
      );
      const files = {
        [`${HOME}/.ssh/prod`]: lines('HostName app.example.com', 'Host *', '  IdentityFile ~/k'),
      };
      expect(await resolve('production', config, files)).toMatchObject({
        hostName: 'app.example.com',
        port: 2222,
        user: 'fallback',
        identityFiles: [`${HOME}/k`],
      });
      // In an inactive block even the "Host *" inside the included file stays inactive.
      expect(await resolve('other', config, files)).toMatchObject({
        hostName: 'other',
        port: 22,
        identityFilesAreDefaults: true,
      });
    });

    it('stops recursion', async () => {
      const error = await resolveError('a', 'Include config');
      expect(error.directive).toBe('Include');
      expect(error.message).toMatch(/nested too deeply/);
    });

    it('limits the number of files a glob may pull in', async () => {
      const files: Record<string, string> = { [CONFIG]: 'Include many/*' };
      for (let i = 0; i <= MAX_CONFIG_FILES; i += 1) {
        files[`${HOME}/.ssh/many/f${i}`] = 'User x';
      }
      const error = await errorOf(resolveSshHost('a', environment(files)));
      expect(error.message).toMatch(new RegExp(`more than ${MAX_CONFIG_FILES}`));
    });

    it('limits the number of files read in total', async () => {
      // Every attempt counts, also for files that do not exist.
      const includes = Array.from({ length: MAX_CONFIG_FILES }, (_, i) => `Include missing-${i}`);
      const error = await resolveError('a', lines(...includes));
      expect(error.message).toMatch(new RegExp(`more than ${MAX_CONFIG_FILES} configuration`));
      expect(error.line).toBe(MAX_CONFIG_FILES);
    });

    it('rejects a configuration file over the size limit', async () => {
      const error = await resolveError('a', `# ${'x'.repeat(MAX_CONFIG_FILE_BYTES)}`);
      expect(error.message).toMatch(/larger than/);
    });

    it('rejects tokens and character classes', async () => {
      expect((await resolveError('a', 'Include %d/x')).directive).toBe('Include');
      expect((await resolveError('a', 'Include conf.[ab]')).message).toMatch(/character classes/);
    });

    it('reads the system file after the user file, relative to its own directory', async () => {
      const env = environment({
        [CONFIG]: 'Host production\n  User mine',
        '/etc/ssh/ssh_config': 'Include ssh_config.d/*\nHost *\n  User system\n  Port 2200',
        '/etc/ssh/ssh_config.d/proxy.conf': 'Host production\n  ProxyCommand nc %h %p',
      });
      const error = await errorOf(resolveSshHost('production', env));
      expect(error.file).toBe('/etc/ssh/ssh_config.d/proxy.conf');
      const other = await resolveSshHost('other', env);
      expect(other).toMatchObject({ user: 'system', port: 2200 });
    });

    it('reads the system file from an explicit path', async () => {
      const env = environment(
        { '/var/www/app/ssh_config': 'User from-system' },
        { systemConfigPath: '/var/www/app/ssh_config' },
      );
      await expect(resolveSshHost('a', env)).resolves.toMatchObject({ user: 'from-system' });
    });

    it('reads no system file when it is disabled', async () => {
      const env = environment({ '/etc/ssh/ssh_config': 'ProxyJump x' }, { systemConfigPath: null });
      await expect(resolveSshHost('a', env)).resolves.toMatchObject({ hostName: 'a' });
      expect(env.reads).toEqual([CONFIG]);
    });
  });

  it('reports syntax errors with file and line', async () => {
    const error = await resolveError('a', lines('Host a', '  HostName "unterminated'));
    expect(error.message).toMatch(/Unterminated quote/);
    expect(error.line).toBe(2);
  });

  it('propagates read errors instead of treating the file as missing', async () => {
    const env = environment({});
    const failing: SshConfigEnvironment = {
      ...env,
      readFile: () => Promise.reject(new Error('permission denied')),
    };
    await expect(resolveSshHost('a', failing)).rejects.toThrow('permission denied');
  });

  it('uses Windows paths and system files when asked to', async () => {
    const home = 'D:\\home\\deploy';
    const reads: string[] = [];
    const host = await resolveSshHost('a', {
      ...environment({}),
      homeDirectory: home,
      platform: 'win32',
      programDataDirectory: 'E:\\ProgramData',
      readFile: (path) => {
        reads.push(path);
        return Promise.resolve(
          path === `${home}\\.ssh\\config` ? 'IdentityFile ~/.ssh/work' : undefined,
        );
      },
    });
    expect(host.identityFiles).toEqual([`${home}\\.ssh\\work`]);
    expect(host.userKnownHostsFiles[0]).toBe(`${home}\\.ssh\\known_hosts`);
    expect(host.globalKnownHostsFiles).toEqual([
      'E:\\ProgramData\\ssh\\ssh_known_hosts',
      'E:\\ProgramData\\ssh\\ssh_known_hosts2',
    ]);
    expect(reads).toEqual([`${home}\\.ssh\\config`, 'E:\\ProgramData\\ssh\\ssh_config']);
  });

  it('treats NUL as the null device on Windows', async () => {
    const env: SshConfigEnvironment = {
      ...environment({}),
      homeDirectory: 'D:\\home\\deploy',
      platform: 'win32',
      readFile: (path) =>
        Promise.resolve(
          path.endsWith('\\.ssh\\config') ? 'UserKnownHostsFile D:\\x\\NUL' : undefined,
        ),
    };
    expect((await errorOf(resolveSshHost('a', env))).directive).toBe('UserKnownHostsFile');
  });
});

describe('listSshHostAliases', () => {
  it('lists valid Host names without wildcards, negations or duplicates, from all includes', async () => {
    const env = environment({
      [CONFIG]: lines(
        'Host production staging *.example.com !blocked',
        'Host app? web ../evil',
        '  Include more',
        'Match exec "false"',
        '  Include matched',
        'Host Production',
      ),
      [`${HOME}/.ssh/more`]: 'Host from-include\n  ProxyJump bastion.example.com',
      [`${HOME}/.ssh/matched`]: 'Host from-match',
    });
    expect(await listSshHostAliases(env)).toEqual([
      'production',
      'staging',
      'web',
      'from-include',
      'from-match',
    ]);
    expect(env.reads).not.toContain('/etc/ssh/ssh_config');
  });

  it('returns an empty list without a config file', async () => {
    expect(await listSshHostAliases(environment({}))).toEqual([]);
  });
});
