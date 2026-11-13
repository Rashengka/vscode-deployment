import { describe, expect, it } from 'vitest';
import {
  ALLOWED_CIPHERS,
  ALLOWED_KEX,
  ALLOWED_MACS,
  AlgorithmError,
  transportAlgorithms,
} from '../../../src/ssh/algorithms';
import * as ssh2 from '../../../src/ssh/ssh2Bundle';

const ssh2Supported = {
  kex: ssh2.supportedKexAlgorithms,
  cipher: ssh2.supportedCipherAlgorithms,
  mac: ssh2.supportedMacAlgorithms,
};

describe('transport algorithm allowlist', () => {
  const all = [...ALLOWED_KEX, ...ALLOWED_CIPHERS, ...ALLOWED_MACS];

  it('contains nothing based on SHA-1, MD5, CBC, RC4 or 3DES', () => {
    expect(all.length).toBeGreaterThan(10);
    expect(
      all.filter((name) => /sha1|md5|-cbc|arcfour|3des|blowfish|cast128|group1-/i.test(name)),
    ).toEqual([]);
  });

  it('is accepted by the ssh2 build and keeps the allowlist order', () => {
    const result = transportAlgorithms(ssh2Supported);
    expect(result.kex[0]).toBe('curve25519-sha256');
    expect(result.cipher.slice(0, 2)).toEqual(ALLOWED_CIPHERS.slice(0, 2));
    expect(result.compress).toEqual(['none']);
    for (const [list, allowed] of [
      [result.kex, ALLOWED_KEX],
      [result.cipher, ALLOWED_CIPHERS],
      [result.hmac, ALLOWED_MACS],
    ] as const) {
      expect(list.every((name) => allowed.includes(name))).toBe(true);
    }
  });

  it('drops algorithms the runtime does not support', () => {
    const result = transportAlgorithms({
      kex: ['diffie-hellman-group14-sha256', 'diffie-hellman-group1-sha1'],
      cipher: ['aes128-ctr', 'aes128-cbc'],
      mac: ['hmac-sha2-256', 'hmac-sha1'],
    });
    expect(result).toEqual({
      kex: ['diffie-hellman-group14-sha256'],
      cipher: ['aes128-ctr'],
      hmac: ['hmac-sha2-256'],
      compress: ['none'],
    });
  });

  it.each([
    ['key exchange', { kex: ['diffie-hellman-group1-sha1'] }],
    ['cipher', { cipher: ['aes128-cbc'] }],
    ['MAC', { mac: ['hmac-sha1'] }],
  ])(
    'fails instead of returning an empty %s list (ssh2 would fall back to its defaults)',
    (kind, patch) => {
      expect(() => transportAlgorithms({ ...ssh2Supported, ...patch })).toThrow(AlgorithmError);
      expect(() => transportAlgorithms({ ...ssh2Supported, ...patch })).toThrow(kind);
    },
  );
});
