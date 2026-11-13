/**
 * Public key authentication without handing ssh2 a passphrase or a key file.
 *
 * - Keys whose public half is known without the passphrase (OpenSSH and PPK files carry it, or
 *   a `.pub` file lies next to the key) are offered through an in-process agent object. ssh2
 *   first asks the server whether it would accept each public key and calls the agent's `sign`
 *   only for a key the server accepts; only then is the passphrase asked for and the key
 *   decrypted. The decrypted key is used for that one signature and not kept.
 * - Keys without a readable public half are decrypted first (asking for the passphrase) and
 *   passed to ssh2 as an already parsed key.
 * - With `useSshAgent`, the user's SSH agent is offered as well (never forwarded).
 * - User authentication signatures never use SHA-1: when a server accepts RSA keys only as
 *   `ssh-rsa` (no `server-sig-algs`, or one without rsa-sha2-256/512), the key file is not used
 *   for signing. This cannot be enforced for the user's own SSH agent: ssh2 asks it for the
 *   signature algorithm the server allows, and the agent signs with it.
 *
 * ssh2's `privateKey` and `passphrase` connect options are never used, so ssh2 keeps neither.
 */
import type {
  AgentAuthMethod,
  AuthHandlerMiddleware,
  BaseAgent,
  ParsedKey,
  PublicKeyAuthMethod,
} from 'ssh2';
import type { KeyDerivation } from './keyDerivation';
import { ConnectionAttemptEndedError, withPassphrase, type PassphrasePrompt } from './passphrase';
import {
  UnsupportedKeyError,
  decryptKeyFile,
  inspectKeyFile,
  parsePublicKeyLine,
  readKeyFile,
  type KeyParser,
} from './privateKey';

/** A key file that can be offered to the server. */
export interface Identity {
  readonly file: string;
  readonly encrypted: boolean;
  /** Public key in SSH wire format, when known without decrypting. */
  readonly publicKey: Buffer | undefined;
  /** The file content; overwritten by {@link disposeIdentities}. */
  readonly content: Buffer;
}

export interface SkippedIdentity {
  readonly file: string;
  readonly reason: string;
}

function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Reads the identity files. A missing default key is skipped quietly (most users have only
 * one of them); a missing or unusable explicitly configured key is an error, so that a typo
 * never leads to a connection with another key.
 */
export async function loadIdentities(
  files: readonly string[],
  filesAreDefaults: boolean,
  readText: (path: string) => Promise<string | undefined>,
): Promise<{ identities: Identity[]; skipped: SkippedIdentity[] }> {
  const identities: Identity[] = [];
  const skipped: SkippedIdentity[] = [];
  for (const file of files) {
    let content: Buffer;
    try {
      content = await readKeyFile(file);
    } catch (error) {
      if (filesAreDefaults && isNotFound(error)) {
        continue;
      }
      if (isNotFound(error)) {
        throw new UnsupportedKeyError(file, 'the identity file does not exist.');
      }
      throw error;
    }
    let info;
    try {
      info = inspectKeyFile(content.toString('latin1'), file);
    } catch (error) {
      content.fill(0);
      if (filesAreDefaults && error instanceof UnsupportedKeyError) {
        skipped.push({ file, reason: error.message });
        continue;
      }
      throw error;
    }
    let publicKey = info.publicKey;
    if (publicKey === undefined) {
      const line = await readText(`${file}.pub`);
      const parsed = line === undefined ? undefined : parsePublicKeyLine(line);
      if (parsed !== undefined && (info.keyType === undefined || parsed.keyType === info.keyType)) {
        publicKey = parsed.blob;
      }
    }
    identities.push({ file, encrypted: info.encrypted, publicKey, content });
  }
  return { identities, skipped };
}

export function disposeIdentities(identities: readonly Identity[]): void {
  for (const identity of identities) {
    identity.content.fill(0);
  }
}

export class KeyMismatchError extends Error {
  constructor(file: string) {
    super(`${file} does not match its public key (${file}.pub); fix or remove the .pub file.`);
    this.name = 'KeyMismatchError';
  }
}

export interface AuthenticationContext {
  readonly username: string;
  /** For the passphrase prompt, e.g. `deploy@example.com:22`. */
  readonly target: string;
  readonly identities: readonly Identity[];
  /** The agent socket when the server allows the agent, otherwise `undefined`. */
  readonly agentSocket: string | undefined;
  /** With `IdentitiesOnly`, only agent keys that match an identity file are offered. */
  readonly identitiesOnly: boolean;
  readonly prompt: PassphrasePrompt;
  readonly parser: KeyParser;
  readonly deriveKey: KeyDerivation;
  /** ssh2's agent base class (from the bundle) and agent factory. */
  readonly BaseAgent: typeof BaseAgent;
  readonly createAgent: (socketPath: string) => BaseAgent;
  /**
   * Called with an error that must end the connection attempt (cancelled prompt, too many
   * wrong passphrases, unusable key); the caller closes the connection.
   */
  readonly onFatalError: (error: Error) => void;
  /** Aborted when the connection attempt ends; prompts close and nothing is unlocked after. */
  readonly signal: AbortSignal;
  /** Called once, when ssh2 starts user authentication (the host key is verified by then). */
  readonly onAuthenticationStarted: () => void;
  /**
   * Runs local work during authentication (passphrase prompt, key derivation), so that the
   * caller can stop its authentication timeout meanwhile: waiting for the user never counts.
   */
  readonly localWork: <T>(work: () => Promise<T>) => Promise<T>;
}

/** Whether ssh2 asks for a SHA-1 signature (`ssh-rsa`); other key types have no hash choice. */
export function isSha1Signature(keyType: string, hash: string | undefined): boolean {
  return hash === 'sha1' || (keyType === 'ssh-rsa' && hash === undefined);
}

export class Sha1SignatureRefusedError extends Error {
  constructor(file: string) {
    super(
      `${file}: the server accepts this RSA key only with SHA-1 signatures (ssh-rsa), which ` +
        'this extension does not use. Use an ed25519 or ECDSA key, or enable rsa-sha2-256 or ' +
        'rsa-sha2-512 on the server.',
    );
    this.name = 'Sha1SignatureRefusedError';
  }
}

/** Makes `key.sign` refuse SHA-1 signatures, for keys that ssh2 signs with directly. */
export function refuseSha1Signatures(key: ParsedKey, file: string): ParsedKey {
  const sign = key.sign.bind(key);
  const guarded = (data: Buffer | string, algo?: string): Buffer => {
    if (isSha1Signature(key.type, algo)) {
      // ssh2 treats an Error returned by sign() as a failed signature and tries the next method.
      return new Sha1SignatureRefusedError(file) as unknown as Buffer;
    }
    return sign(data, algo);
  };
  Object.defineProperty(key, 'sign', { value: guarded });
  return key;
}

function throwIfEnded(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ConnectionAttemptEndedError();
  }
}

/** Decrypts an identity, asking for the passphrase when it is encrypted. */
async function unlock(identity: Identity, context: AuthenticationContext): Promise<ParsedKey> {
  throwIfEnded(context.signal);
  const decrypt = (passphrase: Buffer | undefined): Promise<ParsedKey> =>
    decryptKeyFile(
      identity.content,
      identity.file,
      passphrase,
      context.parser,
      context.deriveKey,
      context.signal,
    );
  const key = await context.localWork(() =>
    identity.encrypted
      ? withPassphrase(context.prompt, identity.file, context.target, context.signal, decrypt)
      : decrypt(undefined),
  );
  throwIfEnded(context.signal);
  if (identity.publicKey !== undefined && !key.getPublicSSH().equals(identity.publicKey)) {
    throw new KeyMismatchError(identity.file);
  }
  return key;
}

type SignCallback = (error?: Error | null, signature?: Buffer) => void;

/** The in-process agent for identity files whose public key is known. */
function identityFileAgent(
  identities: readonly Identity[],
  context: AuthenticationContext,
  state: { fatal: Error | undefined },
): BaseAgent {
  const Base = context.BaseAgent as unknown as new () => BaseAgent;
  class IdentityFileAgent extends Base {
    getIdentities(callback: (error: Error | null, keys?: Buffer[]) => void): void {
      callback(
        null,
        identities.flatMap((identity) =>
          identity.publicKey === undefined ? [] : [identity.publicKey],
        ),
      );
    }

    sign(
      publicKey: ParsedKey,
      data: Buffer,
      options: { hash?: string } | SignCallback,
      callback?: SignCallback,
    ): void {
      const done = typeof options === 'function' ? options : callback;
      const hash = typeof options === 'function' ? undefined : options.hash;
      if (done === undefined) {
        return;
      }
      if (state.fatal !== undefined) {
        done(state.fatal);
        return;
      }
      if (context.signal.aborted) {
        done(new ConnectionAttemptEndedError());
        return;
      }
      const blob = publicKey.getPublicSSH();
      const identity = identities.find((candidate) => candidate.publicKey?.equals(blob));
      if (identity === undefined) {
        done(new Error('The server asked to sign with a key that was not offered.'));
        return;
      }
      // Refused before asking for the passphrase. Not fatal: ssh2 tries the next key.
      if (isSha1Signature(publicKey.type, hash)) {
        done(new Sha1SignatureRefusedError(identity.file));
        return;
      }
      // When the server rejects the signature, ssh2 may ask again with the other RSA hash
      // (rsa-sha2-256 after rsa-sha2-512); the key is then unlocked, and its passphrase asked
      // for, a second time. Rare and harmless, and better than keeping the key unlocked.
      unlock(identity, context).then(
        (key) => {
          const signature = key.sign(data, hash);
          if (signature instanceof Error) {
            done(new Error(`Signing with ${identity.file} failed.`));
          } else {
            done(null, signature);
          }
        },
        (error: unknown) => {
          const fatal = error instanceof Error ? error : new Error(String(error));
          state.fatal = fatal;
          context.onFatalError(fatal);
          done(fatal);
        },
      );
    }
  }
  return new IdentityFileAgent();
}

/** Restricts an agent to the keys of the identity files (`IdentitiesOnly yes`). */
function filteredAgent(
  agent: BaseAgent,
  allowed: readonly Buffer[],
  context: AuthenticationContext,
): BaseAgent {
  const Base = context.BaseAgent as unknown as new () => BaseAgent;
  class FilteredAgent extends Base {
    getIdentities(callback: (error: Error | null, keys?: ParsedKey[]) => void): void {
      agent.getIdentities((error, keys) => {
        if (error !== undefined && error !== null) {
          callback(error);
          return;
        }
        const list = (keys ?? []) as ParsedKey[];
        callback(
          null,
          list.filter((key) => allowed.some((blob) => key.getPublicSSH().equals(blob))),
        );
      });
    }

    sign(
      publicKey: ParsedKey,
      data: Buffer,
      options: { hash?: 'sha1' | 'sha256' | 'sha512' } | SignCallback,
      callback?: SignCallback,
    ): void {
      if (typeof options === 'function') {
        agent.sign(publicKey, data, options);
      } else {
        agent.sign(publicKey, data, options, callback);
      }
    }
  }
  return new FilteredAgent();
}

type Step = () => Promise<AgentAuthMethod | PublicKeyAuthMethod>;

/**
 * The `authHandler` for ssh2 and whether there is anything to try at all. Methods are tried
 * in this order: the SSH agent (when allowed), identity files with a known public key (one
 * passphrase prompt at most, for the key the server accepts), then the other identity files.
 */
export function createAuthHandler(context: AuthenticationContext): {
  handler: AuthHandlerMiddleware;
  methodCount: number;
} {
  const state: { fatal: Error | undefined } = { fatal: undefined };
  const steps: Step[] = [];
  const username = context.username;
  if (context.agentSocket !== undefined) {
    const socket = context.agentSocket;
    steps.push(() => {
      if (!context.identitiesOnly) {
        return Promise.resolve({ type: 'agent', username, agent: socket });
      }
      const allowed = context.identities.flatMap((identity) =>
        identity.publicKey === undefined ? [] : [identity.publicKey],
      );
      return Promise.resolve({
        type: 'agent',
        username,
        agent: filteredAgent(context.createAgent(socket), allowed, context),
      });
    });
  }
  const withPublicKey = context.identities.filter((identity) => identity.publicKey !== undefined);
  if (withPublicKey.length > 0) {
    steps.push(() =>
      Promise.resolve({
        type: 'agent',
        username,
        agent: identityFileAgent(withPublicKey, context, state),
      }),
    );
  }
  for (const identity of context.identities.filter(
    (candidate) => candidate.publicKey === undefined,
  )) {
    steps.push(async () => ({
      type: 'publickey',
      username,
      key: refuseSha1Signatures(await unlock(identity, context), identity.file),
    }));
  }

  let next = 0;
  const handler: AuthHandlerMiddleware = (_methodsLeft, _partialSuccess, callback) => {
    if (next === 0) {
      context.onAuthenticationStarted();
    }
    const step = state.fatal === undefined ? steps[next] : undefined;
    next += 1;
    if (step === undefined) {
      callback(false as unknown as Parameters<typeof callback>[0]);
      return;
    }
    step().then(callback, (error: unknown) => {
      const fatal = error instanceof Error ? error : new Error(String(error));
      state.fatal = fatal;
      context.onFatalError(fatal);
      callback(false as unknown as Parameters<typeof callback>[0]);
    });
  };
  return { handler, methodCount: steps.length };
}
