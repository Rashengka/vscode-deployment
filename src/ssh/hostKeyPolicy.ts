/**
 * Host key checking for one connection: which host key algorithms to offer and whether the key
 * the server presents is trusted. Host keys are always checked strictly against known_hosts;
 * an unknown, changed or revoked key is refused and nothing is ever written to known_hosts.
 */
import { serverHostKeyAlgorithms } from './hostKeyAlgorithms';
import {
  lookupKnownHosts,
  parseKnownHosts,
  sha256Fingerprint,
  verifyHostKey,
  type KnownHostKey,
  type KnownHostsLookup,
  type ParsedKnownHosts,
} from './knownHosts';
import { SUPPORTED_KEY_TYPES, keyTypeOfBlob } from './privateKey';

/** Largest known_hosts file that is read. */
export const MAX_KNOWN_HOSTS_BYTES = 16 * 1024 * 1024;

export type HostKeyProblem = 'unknown' | 'changed' | 'revoked';

export class HostKeyRejectedError extends Error {
  readonly problem: HostKeyProblem;
  /** `SHA256:` fingerprint of the key the server presented. */
  readonly fingerprint: string;

  constructor(problem: HostKeyProblem, fingerprint: string, message: string) {
    super(message);
    this.name = 'HostKeyRejectedError';
    this.problem = problem;
    this.fingerprint = fingerprint;
  }
}

export interface HostKeyTarget {
  /** The ssh config alias, or `undefined` for a manual connection. */
  readonly alias: string | undefined;
  readonly hostName: string;
  readonly port: number;
  readonly user: string;
}

export interface HostKeyPolicy {
  /** Host key algorithms to offer; never empty. */
  readonly algorithms: readonly string[];
  /** Key types known_hosts lists for the host (empty for an unknown host). */
  readonly knownKeyTypes: readonly string[];
  /** `undefined` when `presentedKey` (SSH wire format) is trusted, otherwise the reason. */
  check(presentedKey: Buffer): HostKeyRejectedError | undefined;
}

/** Reads and parses known_hosts files; a missing file counts as empty. */
export async function readKnownHostsFiles(
  files: readonly string[],
  readFile: (path: string) => Promise<string | undefined>,
): Promise<ParsedKnownHosts[]> {
  const parsed: ParsedKnownHosts[] = [];
  for (const file of files) {
    const text = await readFile(file);
    if (text !== undefined) {
      parsed.push(parseKnownHosts(text, file));
    }
  }
  return parsed;
}

/** The command that lets the user check and accept the host key with OpenSSH. */
export function sshCommandFor(target: HostKeyTarget): string {
  if (target.alias !== undefined) {
    return `ssh ${target.alias}`;
  }
  const port = target.port === 22 ? '' : ` -p ${target.port}`;
  return `ssh${port} ${target.user}@${target.hostName}`;
}

function describeKey(key: KnownHostKey): string {
  return `${key.keyType} ${key.fingerprint} (${key.source.file}:${key.source.line})`;
}

/** Builds the error for a key that is not trusted. Exported for tests of the wording. */
export function hostKeyRejection(
  problem: HostKeyProblem,
  lookup: KnownHostsLookup,
  presentedKey: Buffer,
  target: HostKeyTarget,
  knownHostsFiles: readonly string[],
): HostKeyRejectedError {
  const fingerprint = sha256Fingerprint(presentedKey);
  const presented = `${keyTypeOfBlob(presentedKey) ?? 'unknown type'} key ${fingerprint}`;
  switch (problem) {
    case 'unknown':
      return new HostKeyRejectedError(
        problem,
        fingerprint,
        `The host ${lookup.name} is not in known_hosts (${knownHostsFiles.join(', ') || 'no file'}). ` +
          `The server presented the ${presented}. ` +
          `Run "${sshCommandFor(target)}" in a terminal, check that the fingerprint matches the ` +
          'one from your server administrator and accept it there. ' +
          'This extension never adds keys to known_hosts.',
      );
    case 'changed':
      return new HostKeyRejectedError(
        problem,
        fingerprint,
        `WARNING: the host key of ${lookup.name} has changed. The server presented the ` +
          `${presented}, but known_hosts lists ${lookup.keys.map(describeKey).join(', ')}. ` +
          'This is a possible man-in-the-middle attack. Verify the server key with the server ' +
          'administrator before connecting again. Not connected.',
      );
    case 'revoked': {
      const entry = lookup.revoked.find((key) => key.keyBlob.equals(presentedKey));
      const where = entry === undefined ? '' : ` (${entry.source.file}:${entry.source.line})`;
      return new HostKeyRejectedError(
        problem,
        fingerprint,
        `The server ${lookup.name} presented the ${presented}, which is revoked in known_hosts${where}. ` +
          'Not connected.',
      );
    }
  }
}

/**
 * The host key policy for `knownHostsName` (see the ssh config resolver).
 *
 * When known_hosts has keys for the host, only their signature algorithms are offered, so the
 * server presents a key that can be checked. When it has none, every allowed algorithm is
 * offered only to learn the key's fingerprint for the message; that key is always refused.
 */
export function hostKeyPolicy(
  files: readonly ParsedKnownHosts[],
  fileNames: readonly string[],
  knownHostsName: string,
  target: HostKeyTarget,
  supportedAlgorithms: readonly string[],
): HostKeyPolicy {
  const lookup = lookupKnownHosts(files, knownHostsName);
  const keyTypes =
    lookup.keys.length === 0 ? SUPPORTED_KEY_TYPES : lookup.keys.map((key) => key.keyType);
  const algorithms = serverHostKeyAlgorithms(keyTypes, supportedAlgorithms);
  return {
    algorithms,
    knownKeyTypes: [...new Set(lookup.keys.map((key) => key.keyType))],
    check(presentedKey) {
      const verdict = verifyHostKey(lookup, presentedKey);
      return verdict === 'trusted'
        ? undefined
        : hostKeyRejection(verdict, lookup, presentedKey, target, fileNames);
    },
  };
}
