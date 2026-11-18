/**
 * Key pairs from ssh2's `utils.generateKeyPairSync` for tests, without its ed25519 defect:
 * ssh2 1.17.0 removes every leading zero byte from the public key it reads from the DER
 * encoding (`keygen.js`, "Remove leading zero bytes"), not only the BIT STRING's unused-bits
 * byte. About 1 in 256 ed25519 keys then gets a 31-byte public key, and ssh2's own parser
 * refuses the private key file ("Malformed OpenSSH private key"). Such pairs are generated
 * again. Keys made by `ssh-keygen` are not affected.
 */

export interface GeneratedPair {
  readonly private: string;
  readonly public: string;
}

type Generator = (type: string, options?: Record<string, unknown>) => GeneratedPair;

/** Length of the key in an `ssh-ed25519 <base64>` line (32 when correct). */
export function ed25519PublicKeyLength(line: string): number {
  const blob = Buffer.from(line.trim().split(/\s+/)[1] ?? '', 'base64');
  if (blob.length < 4) {
    return -1;
  }
  const nameLength = blob.readUInt32BE(0);
  const keyAt = 4 + nameLength;
  return keyAt + 4 <= blob.length ? blob.readUInt32BE(keyAt) : -1;
}

export function generateTestKeyPair(
  utils: { readonly generateKeyPairSync: unknown },
  type: 'ed25519' | 'ecdsa' | 'rsa',
  options: Record<string, unknown> = {},
): GeneratedPair {
  const generate = utils.generateKeyPairSync as Generator;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const pair = generate(type, options);
    if (type !== 'ed25519' || ed25519PublicKeyLength(pair.public) === 32) {
      return pair;
    }
  }
  throw new Error('ssh2 produced no usable ed25519 key in 50 attempts.');
}
