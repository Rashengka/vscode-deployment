import { describe, expect, it } from 'vitest';
import {
  HostKeyAlgorithmError,
  serverHostKeyAlgorithms,
  signatureAlgorithmsForKeyType,
} from '../../../src/ssh/hostKeyAlgorithms';
import { supportedServerHostKeyAlgorithms } from '../../../src/ssh/ssh2Bundle';

/** OpenSSH vendor algorithm names end with an at sign and the openssh.com domain. */
const openSshAlgorithm = (name: string): string => [name, 'openssh.com'].join('@');

describe('signatureAlgorithmsForKeyType', () => {
  it.each([
    ['ssh-rsa', ['rsa-sha2-512', 'rsa-sha2-256']],
    ['ecdsa-sha2-nistp256', ['ecdsa-sha2-nistp256']],
    ['ecdsa-sha2-nistp384', ['ecdsa-sha2-nistp384']],
    ['ecdsa-sha2-nistp521', ['ecdsa-sha2-nistp521']],
    ['ssh-ed25519', ['ssh-ed25519']],
    ['ssh-dss', []],
    [openSshAlgorithm('sk-ssh-ed25519'), []],
    [openSshAlgorithm('ssh-ed25519-cert-v01'), []],
  ])('maps %s to %j', (keyType, expected) => {
    expect(signatureAlgorithmsForKeyType(keyType)).toEqual(expected);
  });
});

describe('serverHostKeyAlgorithms', () => {
  it('keeps only what known_hosts can verify, in the order of the supported list', () => {
    expect(
      serverHostKeyAlgorithms(
        ['ssh-rsa', 'ssh-ed25519'],
        ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'],
      ),
    ).toEqual(['ssh-ed25519', 'rsa-sha2-512', 'rsa-sha2-256']);
  });

  it('never offers SHA-1 RSA signatures', () => {
    expect(serverHostKeyAlgorithms(['ssh-rsa'], ['ssh-rsa', 'rsa-sha2-256'])).toEqual([
      'rsa-sha2-256',
    ]);
  });

  it('fails instead of returning an empty list', () => {
    expect(() => serverHostKeyAlgorithms([], ['ssh-ed25519'])).toThrow(HostKeyAlgorithmError);
    expect(() => serverHostKeyAlgorithms(['ssh-dss'], ['ssh-dss'])).toThrow(/ssh-dss/);
    expect(() => serverHostKeyAlgorithms(['ssh-ed25519'], ['ecdsa-sha2-nistp256'])).toThrow(
      HostKeyAlgorithmError,
    );
  });

  it('works with the algorithms ssh2 supports', () => {
    expect(supportedServerHostKeyAlgorithms).toContain('rsa-sha2-512');
    expect(
      serverHostKeyAlgorithms(
        ['ssh-rsa', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521'],
        supportedServerHostKeyAlgorithms,
      ),
    ).toEqual(['ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'rsa-sha2-512', 'rsa-sha2-256']);
  });
});
