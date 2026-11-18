/**
 * The errors a connection attempt or a read-only operation is expected to fail with. Their
 * messages are written for the user and never contain a passphrase or key content, so they are
 * shown (after sanitizing). Anything else is a bug and is not caught here.
 */
import { AlgorithmError } from '../ssh/algorithms';
import { KeyMismatchError, Sha1SignatureRefusedError } from '../ssh/authentication';
import {
  ConfigurationChangedError,
  ConnectionError,
  HostKeyTypeUnavailableError,
} from '../ssh/connectionManager';
import { ConnectionSettingsError } from '../ssh/connectionTarget';
import { HostKeyAlgorithmError } from '../ssh/hostKeyAlgorithms';
import { HostKeyRejectedError } from '../ssh/hostKeyPolicy';
import { KeyDerivationError } from '../ssh/keyDerivation';
import { KnownHostsError } from '../ssh/knownHosts';
import {
  ConnectionAttemptEndedError,
  PassphraseCancelledError,
  TooManyPassphraseAttemptsError,
} from '../ssh/passphrase';
import { UnsupportedKeyError, WrongPassphraseError } from '../ssh/privateKey';
import { RemoteWindowError } from '../ssh/remoteWindow';
import { SshConfigError } from '../ssh/sshConfig';

const FAILURES: readonly (abstract new (...args: never[]) => Error)[] = [
  AlgorithmError,
  ConfigurationChangedError,
  ConnectionAttemptEndedError,
  ConnectionError,
  ConnectionSettingsError,
  HostKeyAlgorithmError,
  HostKeyRejectedError,
  HostKeyTypeUnavailableError,
  KeyDerivationError,
  KeyMismatchError,
  KnownHostsError,
  RemoteWindowError,
  Sha1SignatureRefusedError,
  SshConfigError,
  TooManyPassphraseAttemptsError,
  UnsupportedKeyError,
  WrongPassphraseError,
];

export type ConnectionFailure =
  { readonly kind: 'cancelled' } | { readonly kind: 'failed'; readonly message: string };

/** SFTP status errors of ssh2 carry the numeric status code of the server. */
function isSftpStatusError(error: Error): boolean {
  return typeof (error as Error & { code?: unknown }).code === 'number';
}

/**
 * Classifies an expected failure; `undefined` for anything else (which the caller rethrows).
 * The message is the raw one; sanitize it before showing it.
 */
export function connectionFailure(error: unknown): ConnectionFailure | undefined {
  if (error instanceof PassphraseCancelledError) {
    return { kind: 'cancelled' };
  }
  if (!(error instanceof Error)) {
    return undefined;
  }
  if (FAILURES.some((type) => error instanceof type)) {
    return { kind: 'failed', message: error.message };
  }
  if (isSftpStatusError(error)) {
    return { kind: 'failed', message: `The server reported an SFTP error: ${error.message}` };
  }
  return undefined;
}
