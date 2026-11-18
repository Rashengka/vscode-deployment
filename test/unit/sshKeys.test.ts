import { describe, expect, it } from 'vitest';
import { utils } from '../../src/ssh/ssh2Bundle';
import { generateTestKeyPair, ed25519PublicKeyLength } from '../support/sshKeys';

describe('generateTestKeyPair', () => {
  it('works around ssh2 cutting leading zero bytes off ed25519 public keys', () => {
    // ssh2's generator strips every leading zero byte of the public key (1 in 256 keys), which
    // makes a key file ssh2 itself refuses. Searched for, so the case is always covered.
    const raw = (type: 'ed25519') => utils.generateKeyPairSync(type);
    let broken: { private: string; public: string } | undefined;
    for (let attempt = 0; attempt < 20_000 && broken === undefined; attempt += 1) {
      const pair = raw('ed25519');
      if (ed25519PublicKeyLength(pair.public) !== 32) {
        broken = pair;
      }
    }
    expect(broken).toBeDefined();
    expect(utils.parseKey(Buffer.from(broken?.private ?? ''))).toBeInstanceOf(Error);
  });

  it('only returns ed25519 keys that ssh2 can read again', () => {
    for (let attempt = 0; attempt < 3000; attempt += 1) {
      const pair = generateTestKeyPair(utils, 'ed25519');
      expect(ed25519PublicKeyLength(pair.public)).toBe(32);
      expect(utils.parseKey(Buffer.from(pair.private))).not.toBeInstanceOf(Error);
    }
  });
});
