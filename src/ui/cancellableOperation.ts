/**
 * An operation on a server behind a cancellable progress notification, and the classification
 * of how it ended. Shared by Test Connection and Compare with Deployed Version (and later
 * upload), so that cancelling and errors are handled the same way everywhere. Kept free of the
 * VS Code API.
 *
 * Cancelling aborts the operation's signal, gives up waiting for it, and closes the connection
 * only when this operation opened it: a connection that was open before stays open.
 */
import type { ConnectionManager } from '../ssh/connectionManager';
import { connectionFailure } from './connectionFailures';

export interface ProgressHost {
  /** Runs `work` while a cancellable progress notification is shown. */
  withProgress<T>(
    title: string,
    work: (onCancel: (listener: () => void) => void) => Promise<T>,
  ): Promise<T>;
}

export type OperationOutcome<T> =
  | { readonly kind: 'done'; readonly value: T }
  | { readonly kind: 'cancelled' }
  /** An expected failure (see `connectionFailures.ts`); the message is raw, sanitize it. */
  | { readonly kind: 'failed'; readonly message: string; readonly error: unknown }
  /** Anything else is a bug: log the error, never show its message. */
  | { readonly kind: 'unexpected'; readonly error: unknown };

class CancelledByUser extends Error {
  constructor() {
    super('Cancelled.');
    this.name = 'CancelledByUser';
  }
}

export async function runCancellable<T>(
  host: ProgressHost,
  connections: Pick<ConnectionManager, 'status' | 'disconnect'>,
  key: string,
  title: string,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<OperationOutcome<T>> {
  const opensConnection = connections.status(key) === 'disconnected';
  const abort = new AbortController();
  try {
    const value = await host.withProgress(title, (onCancel) => {
      const running = operation(abort.signal);
      // Settled later when cancelled; the outcome is then of no interest.
      running.catch(() => undefined);
      const cancelled = new Promise<never>((_resolve, reject) => {
        onCancel(() => {
          abort.abort();
          if (opensConnection) {
            connections.disconnect(key);
          }
          reject(new CancelledByUser());
        });
      });
      return Promise.race([running, cancelled]);
    });
    return { kind: 'done', value };
  } catch (error) {
    if (abort.signal.aborted) {
      return { kind: 'cancelled' };
    }
    const failure = connectionFailure(error);
    if (failure === undefined) {
      return { kind: 'unexpected', error };
    }
    if (failure.kind === 'cancelled') {
      return { kind: 'cancelled' };
    }
    return { kind: 'failed', message: failure.message, error };
  }
}
