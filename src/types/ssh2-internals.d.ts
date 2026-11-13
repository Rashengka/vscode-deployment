// ssh2 does not publish types for its internal modules; only what we read is declared here.
declare module 'ssh2/lib/protocol/crypto.js' {
  export const bindingAvailable: boolean;
}

declare module 'ssh2/lib/protocol/constants.js' {
  export const SUPPORTED_SERVER_HOST_KEY: readonly string[];
  export const SUPPORTED_KEX: readonly string[];
  export const SUPPORTED_CIPHER: readonly string[];
  export const SUPPORTED_MAC: readonly string[];
}

// bcrypt-pbkdf (a dependency of ssh2) ships no types.
declare module 'bcrypt-pbkdf' {
  export function pbkdf(
    pass: Uint8Array,
    passlen: number,
    salt: Uint8Array,
    saltlen: number,
    key: Uint8Array,
    keylen: number,
    rounds: number,
  ): number;
}
