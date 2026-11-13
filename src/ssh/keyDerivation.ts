/**
 * Runs bcrypt_pbkdf for encrypted OpenSSH keys in a worker thread (see `kdfWorker.ts`), so that
 * a key with many KDF rounds does not freeze the extension host while it is decrypted.
 */
import { Worker } from 'node:worker_threads';
import type { KdfRequest, KdfResponse } from './kdfWorker';

/**
 * Derives `length` bytes from a passphrase. The caller keeps ownership of `passphrase`. When
 * `signal` is aborted the derivation stops and the promise rejects.
 */
export type KeyDerivation = (
  passphrase: Uint8Array,
  salt: Uint8Array,
  rounds: number,
  length: number,
  signal?: AbortSignal,
) => Promise<Buffer>;

export class KeyDerivationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyDerivationError';
  }
}

/**
 * Key derivation in a new worker thread running `workerFile` (the bundled `kdfWorker.js`).
 * `createWorker` exists for tests.
 */
export function workerKeyDerivation(
  workerFile: string,
  createWorker: (file: string) => Worker = (file) => new Worker(file),
): KeyDerivation {
  return (passphrase, salt, rounds, length, signal) =>
    new Promise<Buffer>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new KeyDerivationError('Key derivation was cancelled.'));
        return;
      }
      // A private copy is transferred, so that the worker owns (and wipes) its own bytes and
      // nothing is left behind in a structured clone.
      const copy = new Uint8Array(passphrase.length);
      copy.set(passphrase);
      let worker: Worker;
      try {
        worker = createWorker(workerFile);
      } catch (error) {
        copy.fill(0);
        throw error;
      }
      let settled = false;
      const onAbort = (): void => {
        finish(new KeyDerivationError('Key derivation was cancelled.'));
      };
      const finish = (error: Error | undefined, derived?: Buffer): void => {
        if (settled) {
          derived?.fill(0);
          return;
        }
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        void worker.terminate();
        if (derived === undefined) {
          reject(error ?? new KeyDerivationError('Key derivation failed.'));
        } else {
          resolve(derived);
        }
      };
      worker.once('message', (response: KdfResponse) => {
        finish(undefined, Buffer.from(response.derived));
      });
      // The worker's error never contains the passphrase: it only computes with it.
      worker.once('error', () => {
        finish(new KeyDerivationError('Key derivation failed in the worker thread.'));
      });
      worker.once('exit', () => {
        finish(new KeyDerivationError('The key derivation worker stopped unexpectedly.'));
      });
      const request: KdfRequest = {
        passphrase: copy.buffer,
        salt: Uint8Array.from(salt),
        rounds,
        length,
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      worker.postMessage(request, [copy.buffer]);
    });
}
