/**
 * Entry point of the separately bundled `dist/ssh2.js`.
 *
 * All extension code must load ssh2 through this bundle, never from `node_modules`, so that
 * the code that runs in production is exactly the code that the packaging tests exercise.
 * The native crypto addon and `cpu-features` are replaced at build time (see
 * `scripts/build.mts`), so the bundle always uses the pure JavaScript / WebAssembly paths.
 */
import { BaseAgent, Client, createAgent, utils } from 'ssh2';
import {
  SUPPORTED_CIPHER,
  SUPPORTED_KEX,
  SUPPORTED_MAC,
  SUPPORTED_SERVER_HOST_KEY,
} from 'ssh2/lib/protocol/constants.js';
import { bindingAvailable } from 'ssh2/lib/protocol/crypto.js';

export { BaseAgent, Client, createAgent, utils };

/** Whether ssh2 managed to load its optional native crypto addon. Must be `false` in the bundle. */
export const nativeCryptoBindingAvailable: boolean = bindingAvailable;

/**
 * Host key algorithms this ssh2 build can verify, in ssh2's order of preference. The list is
 * computed by ssh2 at load time (Ed25519 only when the runtime's crypto supports it).
 */
export const supportedServerHostKeyAlgorithms: readonly string[] = [...SUPPORTED_SERVER_HOST_KEY];

/** Key exchange, cipher and MAC algorithms this ssh2 build can use in the current runtime. */
export const supportedKexAlgorithms: readonly string[] = [...SUPPORTED_KEX];
export const supportedCipherAlgorithms: readonly string[] = [...SUPPORTED_CIPHER];
export const supportedMacAlgorithms: readonly string[] = [...SUPPORTED_MAC];
