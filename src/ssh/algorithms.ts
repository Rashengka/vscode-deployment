/**
 * The transport algorithms this extension offers to a server. The lists are explicit, so that
 * a change of ssh2's defaults can never bring back a weak algorithm: nothing based on SHA-1, no
 * CBC mode ciphers, no compression. Host key algorithms are derived from known_hosts instead
 * (see `hostKeyAlgorithms.ts`), which never offers SHA-1 either.
 */

const OPENSSH = '@' + 'openssh.com';
const LIBSSH = '@' + 'libssh.org';

/** Key exchange, strongest and fastest first. */
export const ALLOWED_KEX: readonly string[] = [
  'curve25519-sha256',
  `curve25519-sha256${LIBSSH}`,
  'ecdh-sha2-nistp256',
  'ecdh-sha2-nistp384',
  'ecdh-sha2-nistp521',
  'diffie-hellman-group-exchange-sha256',
  'diffie-hellman-group16-sha512',
  'diffie-hellman-group18-sha512',
  'diffie-hellman-group14-sha256',
];

/**
 * Ciphers. AES-GCM comes first because it is fast without the native addon; ChaCha20-Poly1305
 * then runs in JavaScript.
 */
export const ALLOWED_CIPHERS: readonly string[] = [
  `aes256-gcm${OPENSSH}`,
  `aes128-gcm${OPENSSH}`,
  `chacha20-poly1305${OPENSSH}`,
  'aes256-ctr',
  'aes192-ctr',
  'aes128-ctr',
];

/** MACs (only used with the CTR ciphers; the AEAD ciphers bring their own). */
export const ALLOWED_MACS: readonly string[] = [
  `hmac-sha2-256-etm${OPENSSH}`,
  `hmac-sha2-512-etm${OPENSSH}`,
  'hmac-sha2-256',
  'hmac-sha2-512',
];

export interface SupportedAlgorithms {
  readonly kex: readonly string[];
  readonly cipher: readonly string[];
  readonly mac: readonly string[];
}

export interface TransportAlgorithms {
  readonly kex: string[];
  readonly cipher: string[];
  readonly hmac: string[];
  readonly compress: string[];
}

export class AlgorithmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlgorithmError';
  }
}

function intersect(
  kind: string,
  allowed: readonly string[],
  supported: readonly string[],
): string[] {
  const available = new Set(supported);
  const result = allowed.filter((name) => available.has(name));
  // ssh2 treats an empty list as "use the defaults", which would bring back weak algorithms.
  if (result.length === 0) {
    throw new AlgorithmError(`No allowed ${kind} algorithm is available in this environment.`);
  }
  return result;
}

/** The allowlists filtered to what ssh2 supports here, in the allowlist's order. */
export function transportAlgorithms(supported: SupportedAlgorithms): TransportAlgorithms {
  return {
    kex: intersect('key exchange', ALLOWED_KEX, supported.kex),
    cipher: intersect('cipher', ALLOWED_CIPHERS, supported.cipher),
    hmac: intersect('MAC', ALLOWED_MACS, supported.mac),
    compress: ['none'],
  };
}
