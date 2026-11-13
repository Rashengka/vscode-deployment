/**
 * Parser and lookup for OpenSSH `known_hosts` files.
 *
 * Supported: plain host names, comma separated host lists, `[host]:port`, wildcards and
 * negation, hashed entries (`|1|salt|hmac`, HMAC-SHA1), comments, and the `@revoked` and
 * `@cert-authority` markers. This module never writes to a known_hosts file.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { matchPatternList } from './patterns';

/** Where an entry or a problem comes from, for messages shown to the user. */
export interface KnownHostsSource {
  readonly file: string;
  readonly line: number;
}

export type KnownHostsHostField =
  | { readonly kind: 'patterns'; readonly patterns: readonly string[] }
  | { readonly kind: 'hashed'; readonly salt: Buffer; readonly hash: Buffer };

export interface KnownHostsEntry {
  readonly marker: 'none' | 'revoked' | 'cert-authority';
  readonly hosts: KnownHostsHostField;
  /** Key type as written on the line and inside the key blob, e.g. `ssh-ed25519`. */
  readonly keyType: string;
  /** The public key in SSH wire format (the decoded base64 field). */
  readonly keyBlob: Buffer;
  readonly source: KnownHostsSource;
}

/** A line that was skipped because it could not be parsed. Such a line never trusts a key. */
export interface KnownHostsProblem {
  readonly source: KnownHostsSource;
  readonly reason: string;
}

export interface ParsedKnownHosts {
  readonly entries: readonly KnownHostsEntry[];
  readonly problems: readonly KnownHostsProblem[];
}

export interface KnownHostKey {
  readonly keyType: string;
  readonly keyBlob: Buffer;
  /** OpenSSH style `SHA256:<base64 without padding>`. */
  readonly fingerprint: string;
  readonly source: KnownHostsSource;
}

export interface KnownHostsLookup {
  /** The name that was looked up, e.g. `example.com` or `[example.com]:2222`. */
  readonly name: string;
  /** Keys trusted for the name. Keys that are also listed as revoked are left out. */
  readonly keys: readonly KnownHostKey[];
  /** Every `@revoked` key in the parsed files, whatever host it is written for. */
  readonly revoked: readonly KnownHostKey[];
  /** `@cert-authority` lines that match the name; they are not used to trust anything. */
  readonly ignoredCertificateAuthorities: readonly KnownHostsSource[];
}

export type HostKeyVerdict =
  /** The presented key is listed for the host. */
  | 'trusted'
  /** The presented key is revoked. */
  | 'revoked'
  /** The host has known keys, but the presented key is not one of them. */
  | 'changed'
  /** The host has no known keys at all. */
  | 'unknown';

/** Raised when a known_hosts entry relies on something this extension does not support. */
export class KnownHostsError extends Error {
  readonly source: KnownHostsSource | undefined;

  constructor(message: string, source?: KnownHostsSource) {
    super(message);
    this.name = 'KnownHostsError';
    this.source = source;
  }
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Plain public key types OpenSSH writes to known_hosts. Anything else is skipped as malformed. */
const KNOWN_KEY_TYPES = new Set([
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'ssh-rsa',
  'ssh-dss',
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com',
]);

/** `SHA256:` fingerprint of a public key blob, in the same form as `ssh-keygen -l` prints. */
export function sha256Fingerprint(keyBlob: Buffer): string {
  const digest = createHash('sha256').update(keyBlob).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

/**
 * The name under which OpenSSH stores a host: the bare host for port 22, `[host]:port`
 * otherwise. Host names are compared in lower case.
 */
export function knownHostsName(host: string, port: number): string {
  const lower = host.toLowerCase();
  return port === 22 ? lower : `[${lower}]:${port}`;
}

function decodeBase64(text: string): Buffer | undefined {
  if (!BASE64.test(text) || text.length % 4 !== 0) {
    return undefined;
  }
  return Buffer.from(text, 'base64');
}

/** Reads the leading SSH `string` of a key blob, which is the key type. */
function keyTypeOfBlob(blob: Buffer): string | undefined {
  if (blob.length < 4) {
    return undefined;
  }
  const length = blob.readUInt32BE(0);
  if (length === 0 || length > blob.length - 4) {
    return undefined;
  }
  return blob.toString('latin1', 4, 4 + length);
}

function parseHostField(field: string): KnownHostsHostField | string {
  if (field.startsWith('|')) {
    const parts = field.split('|');
    // ['', '1', salt, hash]
    if (parts.length !== 4 || parts[1] !== '1') {
      return 'unsupported hashed host name format';
    }
    const salt = decodeBase64(parts[2] ?? '');
    const hash = decodeBase64(parts[3] ?? '');
    if (salt?.length !== 20 || hash?.length !== 20) {
      return 'invalid hashed host name';
    }
    return { kind: 'hashed', salt, hash };
  }
  // Empty patterns (as in `a,,b`) are kept: like in OpenSSH they match nothing.
  return { kind: 'patterns', patterns: field.split(',') };
}

/**
 * Parses the text of one known_hosts file. `file` is used only for messages.
 *
 * An invalid line is skipped and reported in `problems`, because it can never trust a key.
 * An unknown `@` marker or an invalid `@revoked` line throws instead: skipping it could hide a
 * revocation, so the file must be fixed first.
 */
export function parseKnownHosts(text: string, file: string): ParsedKnownHosts {
  const entries: KnownHostsEntry[] = [];
  const problems: KnownHostsProblem[] = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const source = { file, line: index + 1 };
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      return;
    }
    const fields = line.split(/\s+/);
    let marker: KnownHostsEntry['marker'] = 'none';
    const skip = (reason: string): void => {
      if (marker === 'revoked') {
        throw new KnownHostsError(
          `Invalid @revoked line in ${file}:${source.line}: ${reason}`,
          source,
        );
      }
      problems.push({ source, reason });
    };
    if (fields[0]?.startsWith('@')) {
      const markerField = fields.shift() ?? '';
      if (markerField === '@revoked') {
        marker = 'revoked';
      } else if (markerField === '@cert-authority') {
        marker = 'cert-authority';
      } else {
        throw new KnownHostsError(
          `Unknown marker ${markerField} in ${file}:${source.line}`,
          source,
        );
      }
    }
    const [hostField, keyType, keyText] = fields;
    if (hostField === undefined || keyType === undefined || keyText === undefined) {
      skip('expected a host, a key type and a key');
      return;
    }
    const hosts = parseHostField(hostField);
    if (typeof hosts === 'string') {
      skip(hosts);
      return;
    }
    if (!KNOWN_KEY_TYPES.has(keyType)) {
      skip(`unknown key type ${keyType}`);
      return;
    }
    const keyBlob = decodeBase64(keyText);
    if (keyBlob === undefined) {
      skip('the key is not valid base64');
      return;
    }
    if (keyTypeOfBlob(keyBlob) !== keyType) {
      skip(`the key does not match the key type ${keyType}`);
      return;
    }
    entries.push({ marker, hosts, keyType, keyBlob, source });
  });
  return { entries, problems };
}

function hostFieldMatches(hosts: KnownHostsHostField, name: string): boolean {
  if (hosts.kind === 'hashed') {
    const digest = createHmac('sha1', hosts.salt).update(name).digest();
    return timingSafeEqual(digest, hosts.hash);
  }
  return matchPatternList(name, hosts.patterns) === 'matched';
}

function toKey(entry: KnownHostsEntry): KnownHostKey {
  return {
    keyType: entry.keyType,
    keyBlob: entry.keyBlob,
    fingerprint: sha256Fingerprint(entry.keyBlob),
    source: entry.source,
  };
}

/**
 * Finds the keys for a known_hosts name (see {@link knownHostsName}).
 *
 * A revoked key is never returned as trusted, whichever host its `@revoked` line names.
 * Host certificates are not supported: when `@cert-authority` lines match the name and no
 * plain key does, this throws, because the host could only be trusted through a certificate.
 */
export function lookupKnownHosts(
  files: readonly ParsedKnownHosts[],
  name: string,
): KnownHostsLookup {
  const lowerName = name.toLowerCase();
  const all = files.flatMap((file) => file.entries);
  const revoked = all.filter((entry) => entry.marker === 'revoked').map(toKey);
  const isRevoked = (blob: Buffer): boolean => revoked.some((key) => key.keyBlob.equals(blob));
  const matching = all.filter((entry) => hostFieldMatches(entry.hosts, lowerName));
  const keys = matching
    .filter((entry) => entry.marker === 'none' && !isRevoked(entry.keyBlob))
    .map(toKey);
  const certificateAuthorities = matching
    .filter((entry) => entry.marker === 'cert-authority')
    .map((entry) => entry.source);
  const [firstAuthority] = certificateAuthorities;
  if (keys.length === 0 && firstAuthority !== undefined) {
    throw new KnownHostsError(
      `${name} is trusted only through @cert-authority (${firstAuthority.file}:${firstAuthority.line}). ` +
        'Host certificates are not supported; add the host key itself to known_hosts.',
      firstAuthority,
    );
  }
  return { name, keys, revoked, ignoredCertificateAuthorities: certificateAuthorities };
}

/** Compares the key presented by a server with the result of {@link lookupKnownHosts}. */
export function verifyHostKey(lookup: KnownHostsLookup, presentedKeyBlob: Buffer): HostKeyVerdict {
  if (lookup.revoked.some((key) => key.keyBlob.equals(presentedKeyBlob))) {
    return 'revoked';
  }
  if (lookup.keys.some((key) => key.keyBlob.equals(presentedKeyBlob))) {
    return 'trusted';
  }
  return lookup.keys.length === 0 ? 'unknown' : 'changed';
}
