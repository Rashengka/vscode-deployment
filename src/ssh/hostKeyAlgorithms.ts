/**
 * Which host key signature algorithms to offer a server, derived from the key types that
 * known_hosts lists for it.
 *
 * Offering only these makes the server present a key that can actually be checked against
 * known_hosts, instead of a key of another type that would then be rejected as unknown.
 */

/** Signature algorithms per key type. SHA-1 (`ssh-rsa` signatures, `ssh-dss`) is never offered. */
const SIGNATURE_ALGORITHMS_BY_KEY_TYPE: ReadonlyMap<string, readonly string[]> = new Map([
  ['ssh-ed25519', ['ssh-ed25519']],
  ['ecdsa-sha2-nistp256', ['ecdsa-sha2-nistp256']],
  ['ecdsa-sha2-nistp384', ['ecdsa-sha2-nistp384']],
  ['ecdsa-sha2-nistp521', ['ecdsa-sha2-nistp521']],
  ['ssh-rsa', ['rsa-sha2-512', 'rsa-sha2-256']],
]);

export class HostKeyAlgorithmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostKeyAlgorithmError';
  }
}

/** Signature algorithms usable with a key of `keyType`; empty for unsupported key types. */
export function signatureAlgorithmsForKeyType(keyType: string): readonly string[] {
  return SIGNATURE_ALGORITHMS_BY_KEY_TYPE.get(keyType) ?? [];
}

/**
 * Host key algorithms to offer, in the order of `supported` (the client's preference).
 *
 * Never returns an empty list: ssh2 treats an empty list as "use the defaults", which would
 * silently accept any key type. When nothing usable is left, this throws instead.
 */
export function serverHostKeyAlgorithms(
  knownKeyTypes: readonly string[],
  supported: readonly string[],
): string[] {
  const wanted = new Set(knownKeyTypes.flatMap((type) => signatureAlgorithmsForKeyType(type)));
  const result = supported.filter((algorithm) => wanted.has(algorithm));
  if (result.length === 0) {
    const types = [...new Set(knownKeyTypes)].join(', ') || 'none';
    throw new HostKeyAlgorithmError(
      `None of the host key types in known_hosts (${types}) can be verified. ` +
        'Supported key types are ssh-ed25519, ecdsa-sha2-nistp256/384/521 and ssh-rsa ' +
        '(with SHA-2 signatures).',
    );
  }
  return result;
}
