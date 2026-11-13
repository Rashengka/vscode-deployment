/**
 * Reading, recognising and decrypting private key files.
 *
 * Supported: OpenSSH keys (the "OPENSSH PRIVATE KEY" format, encrypted with bcrypt), PEM RSA
 * and EC keys (also encrypted ones that ssh2 can read) and PuTTY PPK version 2 RSA keys.
 * PKCS#8, PPK version 3, DSA and security key (`sk-*`) keys are refused with a message that
 * says what to do instead.
 *
 * Error messages name the file and the problem, never any part of the key or the passphrase.
 * The passphrase is only ever handled as a Buffer owned by the caller.
 */
import { createDecipheriv } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { ParsedKey } from 'ssh2';
import type { KeyDerivation } from './keyDerivation';

/** Largest key file that is read; real keys are a few kilobytes. */
export const MAX_KEY_FILE_BYTES = 64 * 1024;
/** Upper bound for bcrypt rounds, so that a damaged file cannot keep a worker busy for hours. */
export const MAX_KDF_ROUNDS = 10_000;

/** Key types that can authenticate. */
export const SUPPORTED_KEY_TYPES: readonly string[] = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'ssh-rsa',
];

export type KeyFormat = 'openssh' | 'pem' | 'ppk2';

export interface KeyFileInfo {
  readonly format: KeyFormat;
  readonly encrypted: boolean;
  /** Key type when it can be read without the passphrase. */
  readonly keyType: string | undefined;
  /** Public key in SSH wire format when it can be read without the passphrase. */
  readonly publicKey: Buffer | undefined;
}

/** The file is not a private key this extension can use. */
export class UnsupportedKeyError extends Error {
  readonly file: string;

  constructor(file: string, problem: string) {
    super(`${file}: ${problem}`);
    this.name = 'UnsupportedKeyError';
    this.file = file;
  }
}

/** The key could not be decrypted with the given passphrase. */
export class WrongPassphraseError extends Error {
  readonly file: string;

  constructor(file: string) {
    super(`The passphrase for ${file} is not correct.`);
    this.name = 'WrongPassphraseError';
    this.file = file;
  }
}

/** Minimal subset of ssh2's `utils` used here. */
export interface KeyParser {
  parseKey(data: Buffer | string, passphrase?: Buffer): ParsedKey | Error;
}

interface CipherInfo {
  readonly name: string;
  readonly keyLength: number;
  readonly ivLength: number;
  readonly blockLength: number;
  readonly authLength: number;
}

const OPENSSH = '@' + 'openssh.com';

function aes(name: string, keyLength: number, gcm: boolean): CipherInfo {
  return gcm
    ? { name, keyLength, ivLength: 12, blockLength: 16, authLength: 16 }
    : { name, keyLength, ivLength: 16, blockLength: 16, authLength: 0 };
}

/** Ciphers OpenSSH can use for private keys and that Node.js decrypts natively. */
const KEY_CIPHERS: ReadonlyMap<string, CipherInfo> = new Map([
  ['aes128-ctr', aes('aes-128-ctr', 16, false)],
  ['aes192-ctr', aes('aes-192-ctr', 24, false)],
  ['aes256-ctr', aes('aes-256-ctr', 32, false)],
  ['aes128-cbc', aes('aes-128-cbc', 16, false)],
  ['aes192-cbc', aes('aes-192-cbc', 24, false)],
  ['aes256-cbc', aes('aes-256-cbc', 32, false)],
  [`aes128-gcm${OPENSSH}`, aes('aes-128-gcm', 16, true)],
  [`aes256-gcm${OPENSSH}`, aes('aes-256-gcm', 32, true)],
]);

/**
 * Authentication tag lengths of ciphers OpenSSH may use for keys but this extension does not
 * decrypt, so that such a key is reported as unsupported rather than as damaged.
 */
const OTHER_CIPHER_AUTH_LENGTHS: ReadonlyMap<string, number> = new Map([
  [`chacha20-poly1305${OPENSSH}`, 16],
]);

const OPENSSH_MAGIC = 'openssh-key-v1\0';
// Assembled from parts, so that this source file does not look like a key to scanners.
const DASHES = '-----';
const OPENSSH_LABEL = 'OPENSSH PRIVATE KEY';
const OPENSSH_BEGIN = `${DASHES}BEGIN ${OPENSSH_LABEL}${DASHES}`;
const OPENSSH_END = `${DASHES}END ${OPENSSH_LABEL}${DASHES}`;
const PEM_BEGIN = new RegExp(`^${DASHES}BEGIN ([A-Z0-9 ]+)${DASHES}\\r?\\n`);

const PKCS8_ADVICE =
  'PKCS#8 keys ("BEGIN PRIVATE KEY") are not supported. Convert the key to the OpenSSH format, ' +
  'for example with "ssh-keygen -p -f <file>" (it keeps the passphrase).';

const PUTTY_EXPORT_ADVICE =
  'Export the key in the OpenSSH format from PuTTYgen ' +
  '(Conversions > Export OpenSSH key (force new file format)).';

class Reader {
  private position = 0;
  private readonly data: Buffer;
  private readonly malformed: () => Error;

  constructor(data: Buffer, malformed: () => Error) {
    this.data = data;
    this.malformed = malformed;
  }

  get remaining(): number {
    return this.data.length - this.position;
  }

  uint32(): number {
    if (this.remaining < 4) {
      throw this.malformed();
    }
    const value = this.data.readUInt32BE(this.position);
    this.position += 4;
    return value;
  }

  bytes(length: number): Buffer {
    if (length > this.remaining) {
      throw this.malformed();
    }
    const value = this.data.subarray(this.position, this.position + length);
    this.position += length;
    return value;
  }

  string(): Buffer {
    return this.bytes(this.uint32());
  }

  text(): string {
    return this.string().toString('latin1');
  }
}

function sshString(value: Buffer | string): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'latin1') : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/** The key type at the start of a public key blob, or `undefined` when the blob is malformed. */
export function keyTypeOfBlob(blob: Buffer): string | undefined {
  if (blob.length < 4) {
    return undefined;
  }
  const length = blob.readUInt32BE(0);
  return length === 0 || length > blob.length - 4
    ? undefined
    : blob.toString('latin1', 4, 4 + length);
}

function checkKeyType(file: string, keyType: string): void {
  if (keyType.startsWith('sk-')) {
    throw new UnsupportedKeyError(
      file,
      'security key (FIDO, "sk-") keys are not supported; use an ed25519, ECDSA or RSA key.',
    );
  }
  if (keyType === 'ssh-dss') {
    throw new UnsupportedKeyError(file, 'DSA keys are not supported (OpenSSH disabled them too).');
  }
  if (!SUPPORTED_KEY_TYPES.includes(keyType)) {
    throw new UnsupportedKeyError(file, `key type ${keyType} is not supported.`);
  }
}

interface OpenSshEnvelope {
  readonly cipherName: string;
  readonly kdfName: string;
  readonly salt: Buffer;
  readonly rounds: number;
  readonly publicKey: Buffer;
  readonly privateBlob: Buffer;
  readonly authTag: Buffer;
}

function damaged(file: string, kind: string): UnsupportedKeyError {
  return new UnsupportedKeyError(file, `the ${kind} key file is damaged.`);
}

function parseOpenSshEnvelope(text: string, file: string): OpenSshEnvelope {
  const malformed = (): Error => damaged(file, 'OpenSSH');
  const end = text.indexOf(OPENSSH_END);
  if (
    !text.startsWith(OPENSSH_BEGIN) ||
    end === -1 ||
    text.slice(end + OPENSSH_END.length).trim() !== ''
  ) {
    throw malformed();
  }
  const body = text.slice(OPENSSH_BEGIN.length, end).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body)) {
    throw malformed();
  }
  const data = Buffer.from(body, 'base64');
  if (data.subarray(0, OPENSSH_MAGIC.length).toString('latin1') !== OPENSSH_MAGIC) {
    throw malformed();
  }
  const reader = new Reader(data.subarray(OPENSSH_MAGIC.length), malformed);
  const cipherName = reader.text();
  const kdfName = reader.text();
  const kdfOptions = reader.string();
  if (reader.uint32() !== 1) {
    throw new UnsupportedKeyError(file, 'files with more than one key are not supported.');
  }
  const publicKey = reader.string();
  const privateBlob = reader.string();
  let salt: Buffer = Buffer.alloc(0);
  let rounds = 0;
  if (kdfName === 'bcrypt') {
    const options = new Reader(kdfOptions, malformed);
    salt = options.string();
    rounds = options.uint32();
    if (salt.length === 0 || options.remaining !== 0) {
      throw malformed();
    }
  } else if (kdfName !== 'none' || kdfOptions.length !== 0) {
    throw new UnsupportedKeyError(file, `key derivation "${kdfName}" is not supported.`);
  }
  const authTag = reader.bytes(
    KEY_CIPHERS.get(cipherName)?.authLength ?? OTHER_CIPHER_AUTH_LENGTHS.get(cipherName) ?? 0,
  );
  if (reader.remaining !== 0) {
    throw malformed();
  }
  return { cipherName, kdfName, salt, rounds, publicKey, privateBlob, authTag };
}

function inspectOpenSsh(text: string, file: string): KeyFileInfo {
  const envelope = parseOpenSshEnvelope(text, file);
  const keyType = keyTypeOfBlob(envelope.publicKey);
  if (keyType === undefined) {
    throw damaged(file, 'OpenSSH');
  }
  checkKeyType(file, keyType);
  const encrypted = envelope.cipherName !== 'none';
  if (encrypted) {
    if (envelope.kdfName !== 'bcrypt') {
      throw damaged(file, 'OpenSSH');
    }
    if (!KEY_CIPHERS.has(envelope.cipherName)) {
      throw new UnsupportedKeyError(
        file,
        `the key is encrypted with ${envelope.cipherName}, which is not supported. ` +
          'Re-encrypt it with "ssh-keygen -p -f <file>" (the default cipher is supported).',
      );
    }
    if (envelope.rounds < 1) {
      throw damaged(file, 'OpenSSH');
    }
    if (envelope.rounds > MAX_KDF_ROUNDS) {
      throw new UnsupportedKeyError(
        file,
        `the key uses ${envelope.rounds} key derivation rounds; ` +
          `at most ${MAX_KDF_ROUNDS} are supported.`,
      );
    }
  } else if (envelope.kdfName !== 'none') {
    throw damaged(file, 'OpenSSH');
  }
  return { format: 'openssh', encrypted, keyType, publicKey: envelope.publicKey };
}

const PPK2_HEADER =
  /^PuTTY-User-Key-File-2: (\S+)\r?\nEncryption: (\S+)\r?\nComment: [^\r\n]*\r?\nPublic-Lines: (\d+)\r?\n/;

function inspectPpk(text: string, file: string): KeyFileInfo {
  const header = PPK2_HEADER.exec(text);
  if (header === null) {
    throw damaged(file, 'PuTTY');
  }
  const [, keyType = '', encryption = '', publicLines = '0'] = header;
  checkKeyType(file, keyType);
  if (keyType !== 'ssh-rsa') {
    throw new UnsupportedKeyError(
      file,
      `PuTTY version 2 keys of type ${keyType} are not supported. ${PUTTY_EXPORT_ADVICE}`,
    );
  }
  if (encryption !== 'none' && encryption !== 'aes256-cbc') {
    throw new UnsupportedKeyError(file, `PuTTY key encryption ${encryption} is not supported.`);
  }
  const lines = text.slice(header[0].length).split(/\r?\n/).slice(0, Number(publicLines)).join('');
  const publicKey = Buffer.from(lines, 'base64');
  if (keyTypeOfBlob(publicKey) !== keyType) {
    throw damaged(file, 'PuTTY');
  }
  return { format: 'ppk2', encrypted: encryption !== 'none', keyType, publicKey };
}

/**
 * Recognises the format of a private key file from its text, without the passphrase.
 * Throws {@link UnsupportedKeyError} for anything that cannot be used.
 */
export function inspectKeyFile(text: string, file: string): KeyFileInfo {
  const content = text.replace(/^\uFEFF/, '').trim();
  if (content.startsWith(OPENSSH_BEGIN)) {
    return inspectOpenSsh(content, file);
  }
  const pem = PEM_BEGIN.exec(content);
  if (pem !== null) {
    const label = pem[1] ?? '';
    const encrypted = /^Proc-Type:[ \t]*4,ENCRYPTED[ \t]*\r?$/m.test(content);
    switch (label) {
      case 'RSA PRIVATE KEY':
        return { format: 'pem', encrypted, keyType: 'ssh-rsa', publicKey: undefined };
      case 'EC PRIVATE KEY':
        return { format: 'pem', encrypted, keyType: undefined, publicKey: undefined };
      case 'DSA PRIVATE KEY':
        checkKeyType(file, 'ssh-dss');
        break;
      case 'PRIVATE KEY':
      case 'ENCRYPTED PRIVATE KEY':
        throw new UnsupportedKeyError(file, PKCS8_ADVICE);
      default:
        break;
    }
    throw new UnsupportedKeyError(file, `"${label}" is not a supported private key.`);
  }
  if (content.startsWith('PuTTY-User-Key-File-2:')) {
    return inspectPpk(content, file);
  }
  if (/^PuTTY-User-Key-File-\d+:/.test(content)) {
    throw new UnsupportedKeyError(
      file,
      `PuTTY keys newer than version 2 are not supported. ${PUTTY_EXPORT_ADVICE}`,
    );
  }
  if (parsePublicKeyLine(content) !== undefined || content.startsWith('---- BEGIN SSH2 PUBLIC')) {
    throw new UnsupportedKeyError(file, 'this is a public key; the private key file is needed.');
  }
  throw new UnsupportedKeyError(file, 'the file is not a private key in a supported format.');
}

/**
 * Reads a key file of at most {@link MAX_KEY_FILE_BYTES}. Only regular files are read.
 * The caller should overwrite the returned buffer when it no longer needs it.
 */
export async function readKeyFile(file: string): Promise<Buffer> {
  const handle = await open(
    file,
    constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK),
  );
  const tooLarge = (): Error =>
    new UnsupportedKeyError(file, `larger than ${MAX_KEY_FILE_BYTES} bytes; not a key file.`);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new UnsupportedKeyError(file, 'not a regular file.');
    }
    if (stats.size > MAX_KEY_FILE_BYTES) {
      throw tooLarge();
    }
    const buffer = Buffer.alloc(MAX_KEY_FILE_BYTES + 1);
    let length = 0;
    try {
      for (;;) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) {
          break;
        }
        length += bytesRead;
        if (length > MAX_KEY_FILE_BYTES) {
          throw tooLarge();
        }
      }
      return Buffer.from(buffer.subarray(0, length));
    } finally {
      buffer.fill(0);
    }
  } finally {
    await handle.close();
  }
}

/**
 * The public key blob from an OpenSSH `.pub` line (`<type> <base64> [comment]`), or
 * `undefined` when the text is not such a line.
 */
export function parsePublicKeyLine(text: string): { keyType: string; blob: Buffer } | undefined {
  const match = /^(\S+)[ \t]+([A-Za-z0-9+/]+={0,2})(?:[ \t][^\r\n]*)?$/.exec(text.trim());
  if (match === null) {
    return undefined;
  }
  const [, keyType = '', base64 = ''] = match;
  const blob = Buffer.from(base64, 'base64');
  return keyTypeOfBlob(blob) === keyType ? { keyType, blob } : undefined;
}

function decryptOpenSsh(
  envelope: OpenSshEnvelope,
  cipher: CipherInfo,
  derived: Buffer,
  file: string,
): Buffer {
  const key = derived.subarray(0, cipher.keyLength);
  const iv = derived.subarray(cipher.keyLength, cipher.keyLength + cipher.ivLength);
  if (envelope.privateBlob.length % cipher.blockLength !== 0) {
    throw damaged(file, 'OpenSSH');
  }
  const parts: Buffer[] = [];
  try {
    if (cipher.authLength > 0) {
      const decipher = createDecipheriv(cipher.name as 'aes-256-gcm', key, iv, {
        authTagLength: cipher.authLength,
      });
      decipher.setAuthTag(envelope.authTag);
      parts.push(decipher.update(envelope.privateBlob));
      try {
        parts.push(decipher.final());
      } catch {
        // With GCM, final() fails only when the authentication tag does not match, which
        // means the derived key, and so the passphrase, is wrong.
        throw new WrongPassphraseError(file);
      }
    } else {
      const decipher = createDecipheriv(cipher.name, key, iv);
      decipher.setAutoPadding(false);
      parts.push(decipher.update(envelope.privateBlob), decipher.final());
    }
    const plain = Buffer.concat(parts);
    // Two equal random check numbers start the plain text; a wrong passphrase breaks them.
    if (plain.length < 8 || plain.readUInt32BE(0) !== plain.readUInt32BE(4)) {
      plain.fill(0);
      throw new WrongPassphraseError(file);
    }
    return plain;
  } finally {
    for (const part of parts) {
      part.fill(0);
    }
  }
}

/** The same OpenSSH key file, unencrypted, for ssh2's parser (which then needs no KDF). */
function unencryptedOpenSsh(publicKey: Buffer, plain: Buffer): Buffer {
  const data = Buffer.concat([
    Buffer.from(OPENSSH_MAGIC, 'latin1'),
    sshString('none'),
    sshString('none'),
    sshString(''),
    Buffer.from([0, 0, 0, 1]),
    sshString(publicKey),
    sshString(plain),
  ]);
  const body = data.toString('base64');
  data.fill(0);
  const lines = body.match(/.{1,70}/g) ?? [];
  return Buffer.from(`${OPENSSH_BEGIN}\n${lines.join('\n')}\n${OPENSSH_END}\n`, 'latin1');
}

function checkParsed(parsed: ParsedKey | Error, file: string, encrypted: boolean): ParsedKey {
  if (parsed instanceof Error) {
    // ssh2's messages are not shown: some of them quote bytes of the file.
    if (encrypted) {
      throw new WrongPassphraseError(file);
    }
    throw new UnsupportedKeyError(file, 'the key could not be read.');
  }
  if (!parsed.isPrivateKey()) {
    throw new UnsupportedKeyError(file, 'the file does not contain a private key.');
  }
  checkKeyType(file, parsed.type);
  return parsed;
}

/**
 * Turns the content of a key file into a parsed private key. `passphrase` is needed for an
 * encrypted key and ignored otherwise; it is neither kept nor modified. Throws
 * {@link WrongPassphraseError} when the passphrase does not decrypt the key.
 */
export async function decryptKeyFile(
  content: Buffer,
  file: string,
  passphrase: Buffer | undefined,
  parser: KeyParser,
  derive: KeyDerivation,
  signal?: AbortSignal,
): Promise<ParsedKey> {
  const text = content.toString('latin1');
  const info = inspectKeyFile(text, file);
  if (!info.encrypted) {
    return checkParsed(parser.parseKey(content), file, false);
  }
  if (passphrase === undefined || passphrase.length === 0) {
    throw new WrongPassphraseError(file);
  }
  if (info.format !== 'openssh') {
    return checkParsed(parser.parseKey(content, passphrase), file, true);
  }
  const envelope = parseOpenSshEnvelope(text.replace(/^\uFEFF/, '').trim(), file);
  const cipher = KEY_CIPHERS.get(envelope.cipherName);
  if (cipher === undefined) {
    throw new UnsupportedKeyError(file, `cipher ${envelope.cipherName} is not supported.`);
  }
  const derived = await derive(
    passphrase,
    envelope.salt,
    envelope.rounds,
    cipher.keyLength + cipher.ivLength,
    signal,
  );
  let plain: Buffer | undefined;
  let unencrypted: Buffer | undefined;
  try {
    plain = decryptOpenSsh(envelope, cipher, derived, file);
    unencrypted = unencryptedOpenSsh(envelope.publicKey, plain);
    return checkParsed(parser.parseKey(unencrypted), file, false);
  } finally {
    derived.fill(0);
    plain?.fill(0);
    unencrypted?.fill(0);
  }
}
