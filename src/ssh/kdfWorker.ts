/**
 * Entry point of the separately bundled `dist/kdfWorker.js`, a worker thread that derives the
 * key of an encrypted OpenSSH private key with bcrypt_pbkdf.
 *
 * bcrypt_pbkdf is deliberately slow (about 10 ms per round in JavaScript; keys made with
 * `ssh-keygen -a 100` need a second), so it must not run on the extension host's main thread.
 *
 * Protocol: one request per worker. The request carries the passphrase in a transferred
 * ArrayBuffer; the worker overwrites it after use and transfers the derived bytes back.
 */
import { pbkdf } from 'bcrypt-pbkdf';
import { parentPort } from 'node:worker_threads';

export interface KdfRequest {
  readonly passphrase: ArrayBuffer;
  readonly salt: Uint8Array;
  readonly rounds: number;
  readonly length: number;
}

/** The derived bytes. A failure ends the worker with an error event instead. */
export interface KdfResponse {
  readonly derived: ArrayBuffer;
}

/** bcrypt_pbkdf as used by OpenSSH for private keys. */
export function bcryptPbkdf(
  passphrase: Uint8Array,
  salt: Uint8Array,
  rounds: number,
  length: number,
): Uint8Array {
  const derived = new Uint8Array(length);
  if (pbkdf(passphrase, passphrase.length, salt, salt.length, derived, length, rounds) !== 0) {
    throw new Error('Key derivation failed.');
  }
  return derived;
}

function handle(request: KdfRequest): ArrayBuffer {
  const passphrase = new Uint8Array(request.passphrase);
  try {
    return bcryptPbkdf(passphrase, request.salt, request.rounds, request.length)
      .buffer as ArrayBuffer;
  } finally {
    passphrase.fill(0);
  }
}

const port = parentPort;
if (port !== null) {
  port.once('message', (request: KdfRequest) => {
    const derived = handle(request);
    const response: KdfResponse = { derived };
    port.postMessage(response, [derived]);
  });
}
