/**
 * Asking for key passphrases.
 *
 * The prompt itself is injected (in VS Code a password input box). This module adds the rules
 * around it: at most one prompt is visible at a time, a wrong passphrase may be retried up to
 * {@link MAX_PASSPHRASE_ATTEMPTS} times, every passphrase buffer is overwritten as soon as the
 * attempt that used it is over, and a prompt whose connection attempt has ended is cancelled.
 * Nothing here keeps a passphrase after an attempt.
 */
import { WrongPassphraseError } from './privateKey';

export const MAX_PASSPHRASE_ATTEMPTS = 3;

export interface PassphraseRequest {
  /** The key file the passphrase is for. */
  readonly keyFile: string;
  /** What is being connected to, for the prompt's title. */
  readonly target: string;
  /** 1 for the first attempt. */
  readonly attempt: number;
  readonly maxAttempts: number;
  /** Whether the previous attempt failed because the passphrase was wrong. */
  readonly previousAttemptFailed: boolean;
  /** Aborted when the connection attempt ends; the prompt should then close itself. */
  readonly signal: AbortSignal;
}

/**
 * Shows a prompt and resolves with the passphrase as a new Buffer that the caller owns, or
 * `undefined` when the user cancels.
 */
export type PassphrasePrompt = (request: PassphraseRequest) => Promise<Buffer | undefined>;

export class PassphraseCancelledError extends Error {
  constructor(keyFile: string) {
    super(`The passphrase prompt for ${keyFile} was cancelled; not connected.`);
    this.name = 'PassphraseCancelledError';
  }
}

/** The connection attempt ended (Disconnect, timeout, failure) while a key was being unlocked. */
export class ConnectionAttemptEndedError extends Error {
  constructor() {
    super('The connection attempt was ended.');
    this.name = 'ConnectionAttemptEndedError';
  }
}

export class TooManyPassphraseAttemptsError extends Error {
  constructor(keyFile: string) {
    super(
      `The passphrase for ${keyFile} was wrong ${MAX_PASSPHRASE_ATTEMPTS} times; not connected. ` +
        'Try again with the correct passphrase.',
    );
    this.name = 'TooManyPassphraseAttemptsError';
  }
}

/** Resolves when `signal` is aborted (never, if it is not). */
export function whenAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
    } else {
      signal.addEventListener(
        'abort',
        () => {
          resolve();
        },
        { once: true },
      );
    }
  });
}

/**
 * Shows the prompt, but gives up as soon as `request.signal` is aborted. A passphrase that
 * arrives after that is overwritten and dropped.
 */
async function promptUntilAborted(
  prompt: PassphrasePrompt,
  request: PassphraseRequest,
): Promise<Buffer | undefined> {
  if (request.signal.aborted) {
    throw new ConnectionAttemptEndedError();
  }
  const shown = prompt(request);
  const aborted = Symbol('aborted');
  const result = await Promise.race([shown, whenAborted(request.signal).then(() => aborted)]);
  if (result === aborted) {
    void shown.then(
      (late) => late?.fill(0),
      () => undefined,
    );
    throw new ConnectionAttemptEndedError();
  }
  return result as Buffer | undefined;
}

/**
 * Wraps a prompt so that at most one is shown at a time; later requests wait for the earlier
 * ones to finish, in order. A request whose connection attempt ended stops waiting (and is
 * never shown), and an aborted prompt no longer blocks the ones behind it.
 */
export function serializePrompts(prompt: PassphrasePrompt): PassphrasePrompt {
  let queue: Promise<unknown> = Promise.resolve();
  return (request) => {
    const turn = queue;
    const result = Promise.race([turn, whenAborted(request.signal)]).then(() =>
      promptUntilAborted(prompt, request),
    );
    // The next prompt waits until this one is answered, fails or is aborted.
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

/**
 * Asks for a passphrase and runs `attempt` with it, asking again (up to
 * {@link MAX_PASSPHRASE_ATTEMPTS} times) while `attempt` throws {@link WrongPassphraseError}.
 * The passphrase buffer is overwritten after each attempt.
 */
export async function withPassphrase<T>(
  prompt: PassphrasePrompt,
  keyFile: string,
  target: string,
  signal: AbortSignal,
  attempt: (passphrase: Buffer) => Promise<T>,
): Promise<T> {
  for (let number = 1; number <= MAX_PASSPHRASE_ATTEMPTS; number += 1) {
    const passphrase = await promptUntilAborted(prompt, {
      keyFile,
      target,
      attempt: number,
      maxAttempts: MAX_PASSPHRASE_ATTEMPTS,
      previousAttemptFailed: number > 1,
      signal,
    });
    if (passphrase === undefined) {
      throw new PassphraseCancelledError(keyFile);
    }
    try {
      return await attempt(passphrase);
    } catch (error) {
      if (!(error instanceof WrongPassphraseError)) {
        throw error;
      }
    } finally {
      passphrase.fill(0);
    }
  }
  throw new TooManyPassphraseAttemptsError(keyFile);
}
