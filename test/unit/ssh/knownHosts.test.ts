import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  KnownHostsError,
  knownHostsName,
  lookupKnownHosts,
  parseKnownHosts,
  sha256Fingerprint,
  verifyHostKey,
  type ParsedKnownHosts,
} from '../../../src/ssh/knownHosts';

// The files in fixtures/openssh are copied unchanged from the OpenSSH portable repository
// (regress/unittests/hostkeys/testdata and regress/unittests/sshkey/testdata, placed in the
// public domain). They were produced by the real ssh-keygen, including `ssh-keygen -H` for the
// hashed entries, so the expected HMAC values do not come from the code under test. They hold
// public keys only.
const FIXTURES = join(import.meta.dirname, 'fixtures', 'openssh');

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

/** The base64 key field of a fixture line whose comment is `comment`. */
function keyWithComment(text: string, comment: string): Buffer {
  const line = text.split('\n').find((candidate) => candidate.endsWith(` ${comment}`));
  const field = line?.split(/\s+/).find((part) => part.startsWith('AAAA'));
  if (field === undefined) {
    throw new Error(`No fixture key with comment ${comment}`);
  }
  return Buffer.from(field, 'base64');
}

const openSshKnownHosts = fixture('known_hosts');
// The upstream file has one line with an unknown marker, which this parser refuses outright
// (tested below). The other tests use the file without that line.
const UNKNOWN_MARKER_LINE = 37;
const parsed = parseKnownHosts(
  openSshKnownHosts
    .split('\n')
    .map((line, index) => (index + 1 === UNKNOWN_MARKER_LINE ? '# removed' : line))
    .join('\n'),
  'known_hosts',
);

function lookup(name: string, files: readonly ParsedKnownHosts[] = [parsed]) {
  return lookupKnownHosts(files, name);
}

function hasKey(name: string, key: Buffer): boolean {
  return lookup(name).keys.some((entry) => entry.keyBlob.equals(key));
}

describe('knownHostsName', () => {
  it('uses the bare host for port 22 and [host]:port otherwise, in lower case', () => {
    expect(knownHostsName('Example.COM', 22)).toBe('example.com');
    expect(knownHostsName('example.com', 2222)).toBe('[example.com]:2222');
  });
});

describe('parseKnownHosts with the OpenSSH test data', () => {
  it('refuses the whole file because of the unknown marker', () => {
    expect(() => parseKnownHosts(openSshKnownHosts, 'known_hosts')).toThrow(KnownHostsError);
    expect(() => parseKnownHosts(openSshKnownHosts, 'known_hosts')).toThrow(
      `Unknown marker @what in known_hosts:${UNKNOWN_MARKER_LINE}`,
    );
  });

  it('skips comments and blank lines and reports each invalid line', () => {
    expect(parsed.problems.map((problem) => problem.reason)).toEqual([
      'expected a host, a key type and a key',
      'expected a host, a key type and a key',
      'the key does not match the key type ssh-ed25519',
      'unknown key type ssh-XXX',
      'the key does not match the key type ssh-rsa',
    ]);
    // 9 plain, 12 hashed, 2 revoked (one tab separated), 1 certificate authority.
    expect(parsed.entries).toHaveLength(24);
    expect(parsed.entries.filter((entry) => entry.hosts.kind === 'hashed')).toHaveLength(12);
  });

  it('finds plain, wildcard and hashed keys for a host', () => {
    const result = lookup('sisyphus.example.com');
    expect(result.keys).toHaveLength(9);
    expect(result.keys.map((key) => key.keyType).sort()).toEqual([
      'ecdsa-sha2-nistp256',
      'ecdsa-sha2-nistp256',
      'ecdsa-sha2-nistp384',
      'ssh-ed25519',
      'ssh-ed25519',
      'ssh-ed25519',
      'ssh-rsa',
      'ssh-rsa',
      'ssh-rsa',
    ]);
  });

  it('matches hashed entries only for the names that ssh-keygen hashed', () => {
    const key5 = keyWithComment(openSshKnownHosts, 'ED25519 #5');
    const key6 = keyWithComment(openSshKnownHosts, 'ED25519 #6');
    // Key #5 exists only as a hashed entry for sisyphus.example.com.
    expect(hasKey('sisyphus.example.com', key5)).toBe(true);
    expect(hasKey('prometheus.example.com', key5)).toBe(false);
    // Key #6 exists only as hashed entries for one host name and two addresses.
    for (const name of ['prometheus.example.com', '192.0.2.1', '2001:db8::1']) {
      expect(hasKey(name, key6)).toBe(true);
    }
    expect(hasKey('sisyphus.example.com', key6)).toBe(false);
    expect(hasKey('192.0.2.2', key6)).toBe(false);
    expect(hasKey('[prometheus.example.com]:2222', key6)).toBe(false);
  });

  it('matches host lists, addresses and wildcards', () => {
    expect(lookup('prometheus.example.com').keys).toHaveLength(9);
    expect(lookup('192.0.2.1').keys).toHaveLength(9);
    expect(lookup('2001:db8::1').keys).toHaveLength(9);
    // Only the wildcard lines apply.
    expect(lookup('other.example.com').keys).toHaveLength(3);
    expect(lookup('192.0.2.200').keys).toHaveLength(3);
    expect(lookup('example.org').keys).toHaveLength(0);
    // A wildcard for the bare name does not cover a non-default port.
    expect(lookup('[other.example.com]:2222').keys).toHaveLength(0);
  });

  it('compares host names case-insensitively', () => {
    expect(lookup('SISYPHUS.example.com').keys).toHaveLength(9);
  });

  it('collects revoked keys and ignores certificate authorities when plain keys exist', () => {
    const result = lookup('prometheus.example.com');
    expect(result.revoked).toHaveLength(2);
    expect(result.ignoredCertificateAuthorities).toHaveLength(1);
  });
});

describe('known_hosts written for this extension', () => {
  const ed25519 = fixture('ed25519_1.pub').trim().split(' ').slice(0, 2).join(' ');
  const ecdsa = fixture('ecdsa_1.pub').trim().split(' ').slice(0, 2).join(' ');
  const rsa = fixture('rsa_1.pub').trim().split(' ').slice(0, 2).join(' ');
  const blob = (line: string): Buffer => Buffer.from(line.split(' ')[1] ?? '', 'base64');

  it('matches [host]:port entries and multiple hosts per line', () => {
    const file = parseKnownHosts(
      [`[example.com]:2222,[192.0.2.10]:2222 ${ed25519}`, `example.com ${ecdsa}`].join('\n'),
      'known_hosts',
    );
    expect(lookup('[example.com]:2222', [file]).keys.map((key) => key.keyType)).toEqual([
      'ssh-ed25519',
    ]);
    expect(lookup('[192.0.2.10]:2222', [file]).keys).toHaveLength(1);
    expect(lookup('example.com', [file]).keys.map((key) => key.keyType)).toEqual([
      'ecdsa-sha2-nistp256',
    ]);
  });

  it('lets a negated pattern exclude a host that a wildcard would match', () => {
    const file = parseKnownHosts(`*.example.com,!staging.example.com ${ed25519}`, 'known_hosts');
    expect(lookup('app.example.com', [file]).keys).toHaveLength(1);
    expect(lookup('staging.example.com', [file]).keys).toHaveLength(0);
  });

  it('never trusts a revoked key, whatever host its @revoked line names', () => {
    const file = parseKnownHosts(
      [
        `example.com ${ed25519}`,
        `example.com ${ecdsa}`,
        `@revoked other.example.org ${ed25519}`,
      ].join('\n'),
      'known_hosts',
    );
    const result = lookup('example.com', [file]);
    expect(result.keys.map((key) => key.keyType)).toEqual(['ecdsa-sha2-nistp256']);
    expect(verifyHostKey(result, blob(ed25519))).toBe('revoked');
    expect(verifyHostKey(result, blob(ecdsa))).toBe('trusted');
    expect(verifyHostKey(result, blob(rsa))).toBe('changed');
    expect(verifyHostKey(lookup('example.org', [file]), blob(rsa))).toBe('unknown');
  });

  it('combines several files', () => {
    const user = parseKnownHosts(`example.com ${ed25519}`, 'user');
    const global = parseKnownHosts(`example.com ${rsa}`, 'global');
    expect(lookup('example.com', [user, global]).keys.map((key) => key.source.file)).toEqual([
      'user',
      'global',
    ]);
  });

  it('rejects a host that is trusted only through @cert-authority', () => {
    const file = parseKnownHosts(`@cert-authority *.example.com ${ed25519}`, 'known_hosts');
    expect(() => lookup('app.example.com', [file])).toThrow(KnownHostsError);
    expect(() => lookup('app.example.com', [file])).toThrow(/@cert-authority.*not supported/);
  });

  it('reports lines whose hashed host or key cannot be decoded', () => {
    const file = parseKnownHosts(
      [
        `|1|short|short ${ed25519}`,
        `|2|AAAA|AAAA ${ed25519}`,
        `example.com ssh-ed25519 not-base64!`,
      ].join('\r\n'),
      'known_hosts',
    );
    expect(file.entries).toHaveLength(0);
    expect(file.problems.map((problem) => problem.source.line)).toEqual([1, 2, 3]);
  });

  it('tolerates empty patterns in a host list, like OpenSSH', () => {
    const file = parseKnownHosts(`example.com,,x ${ed25519}`, 'known_hosts');
    expect(file.problems).toEqual([]);
    expect(lookup('example.com', [file]).keys).toHaveLength(1);
    expect(lookup('x', [file]).keys).toHaveLength(1);
    expect(lookup('', [file]).keys).toHaveLength(1);
    expect(lookup('other', [file]).keys).toHaveLength(0);
  });

  it.each([
    ['an unknown marker', `@trusted example.com ${ed25519}`, /Unknown marker @trusted/],
    ['an @revoked line without a key', '@revoked example.com ssh-ed25519', /Invalid @revoked/],
    ['an @revoked line with a broken key', '@revoked * ssh-ed25519 AAAA', /Invalid @revoked/],
    ['an @revoked line with an unknown type', '@revoked * ssh-foo AAAA', /Invalid @revoked/],
  ])('fails closed on %s', (_name, line, message) => {
    expect(() => parseKnownHosts(`example.com ${ed25519}\n${line}`, 'known_hosts')).toThrow(
      message,
    );
  });
});

describe('sha256Fingerprint', () => {
  it.each(['ed25519_1', 'ecdsa_1', 'rsa_1'])('matches ssh-keygen for %s', (name) => {
    const key = fixture(`${name}.pub`).split(' ')[1] ?? '';
    expect(sha256Fingerprint(Buffer.from(key, 'base64'))).toBe(fixture(`${name}.fp`).trim());
  });
});
