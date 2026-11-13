import {
  createCipheriv,
  createHash,
  createHmac,
  generateKeyPairSync as generateNodeKeyPair,
  randomBytes,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bcryptPbkdf } from '../../../src/ssh/kdfWorker';
import type { KeyDerivation } from '../../../src/ssh/keyDerivation';
import {
  MAX_KDF_ROUNDS,
  UnsupportedKeyError,
  WrongPassphraseError,
  decryptKeyFile,
  inspectKeyFile,
  keyTypeOfBlob,
  parsePublicKeyLine,
} from '../../../src/ssh/privateKey';
import { utils } from '../../../src/ssh/ssh2Bundle';

const FILE = '/home/deploy/.ssh/id_test';
const PASSPHRASE = randomBytes(9).toString('hex');
const OPENSSH = '@' + 'openssh.com';

/** bcrypt in the test process (production runs it in a worker thread). */
const derive: KeyDerivation = (passphrase, salt, rounds, length) =>
  Promise.resolve(Buffer.from(bcryptPbkdf(passphrase, salt, rounds, length)));

function opensshKey(
  type: 'ed25519' | 'ecdsa' | 'rsa',
  options: { cipher?: string; passphrase?: string } = {},
): Buffer {
  const bits = type === 'rsa' ? 2048 : type === 'ecdsa' ? 256 : undefined;
  const generate = utils.generateKeyPairSync as (
    keyType: string,
    options: Record<string, unknown>,
  ) => { private: string };
  const pair = generate(type, {
    ...(bits === undefined ? {} : { bits }),
    ...(options.passphrase === undefined
      ? {}
      : { passphrase: options.passphrase, cipher: options.cipher ?? 'aes256-ctr', rounds: 4 }),
  });
  return Buffer.from(pair.private);
}

function sshString(value: Buffer | string): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'latin1') : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

const DASHES = '-----';
const LABEL = 'OPENSSH PRIVATE KEY';

/** An OpenSSH key file from parts, for formats that are hard to produce otherwise. */
function opensshEnvelope(parts: {
  cipher: string;
  kdf: string;
  kdfOptions: Buffer;
  publicKey: Buffer;
  privateBlob: Buffer;
  authTag?: Buffer;
}): string {
  const data = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'latin1'),
    sshString(parts.cipher),
    sshString(parts.kdf),
    sshString(parts.kdfOptions),
    Buffer.from([0, 0, 0, 1]),
    sshString(parts.publicKey),
    sshString(parts.privateBlob),
    parts.authTag ?? Buffer.alloc(0),
  ]);
  return `${DASHES}BEGIN ${LABEL}${DASHES}\n${data.toString('base64')}\n${DASHES}END ${LABEL}${DASHES}\n`;
}

function bcryptOptions(rounds: number): Buffer {
  const count = Buffer.alloc(4);
  count.writeUInt32BE(rounds);
  return Buffer.concat([sshString(randomBytes(16)), count]);
}

function inspect(content: string | Buffer): ReturnType<typeof inspectKeyFile> {
  return inspectKeyFile(content.toString(), FILE);
}

function expectUnsupported(content: string | Buffer, message: RegExp): void {
  expect(() => inspect(content)).toThrow(UnsupportedKeyError);
  expect(() => inspect(content)).toThrow(message);
}

function mpint(value: Buffer): Buffer {
  const trimmed = value.subarray(value.findIndex((byte) => byte !== 0));
  return sshString((trimmed[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
}

/** A PuTTY version 2 RSA key, built as the PuTTY documentation describes the format. */
function ppk2(passphrase: string | undefined): { text: string; publicKey: Buffer } {
  const { privateKey } = generateNodeKeyPair('rsa', { modulusLength: 2048 });
  const jwk = privateKey.export({ format: 'jwk' });
  const field = (name: 'n' | 'e' | 'd' | 'p' | 'q' | 'qi'): Buffer =>
    mpint(Buffer.from(jwk[name] ?? '', 'base64url'));
  const publicKey = Buffer.concat([sshString('ssh-rsa'), field('e'), field('n')]);
  let privateBlob = Buffer.concat([field('d'), field('p'), field('q'), field('qi')]);
  const encryption = passphrase === undefined ? 'none' : 'aes256-cbc';
  const comment = 'test-key';
  if (passphrase !== undefined) {
    const padding = (16 - (privateBlob.length % 16)) % 16;
    privateBlob = Buffer.concat([privateBlob, randomBytes(padding)]);
  }
  const macKey = createHash('sha1')
    .update('putty-private-key-file-mac-key')
    .update(passphrase ?? '')
    .digest();
  const mac = createHmac('sha1', macKey)
    .update(
      Buffer.concat([
        sshString('ssh-rsa'),
        sshString(encryption),
        sshString(comment),
        sshString(publicKey),
        sshString(privateBlob),
      ]),
    )
    .digest('hex');
  let stored = privateBlob;
  if (passphrase !== undefined) {
    const key = Buffer.concat([
      createHash('sha1')
        .update(Buffer.from([0, 0, 0, 0]))
        .update(passphrase)
        .digest(),
      createHash('sha1')
        .update(Buffer.from([0, 0, 0, 1]))
        .update(passphrase)
        .digest(),
    ]).subarray(0, 32);
    const cipher = createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
    cipher.setAutoPadding(false);
    stored = Buffer.concat([cipher.update(privateBlob), cipher.final()]);
  }
  const lines = (data: Buffer): string[] => data.toString('base64').match(/.{1,64}/g) ?? [];
  const publicLines = lines(publicKey);
  const privateLines = lines(stored);
  const text = [
    'PuTTY-User-Key-File-2: ssh-rsa',
    `Encryption: ${encryption}`,
    `Comment: ${comment}`,
    `Public-Lines: ${publicLines.length}`,
    ...publicLines,
    `Private-Lines: ${privateLines.length}`,
    ...privateLines,
    `Private-MAC: ${mac}`,
    '',
  ].join('\n');
  return { text, publicKey };
}

describe('inspectKeyFile', () => {
  it.each(['ed25519', 'ecdsa', 'rsa'] as const)(
    'reads the type and public key of an OpenSSH %s key, encrypted or not',
    (type) => {
      for (const passphrase of [undefined, PASSPHRASE]) {
        const info = inspect(opensshKey(type, passphrase === undefined ? {} : { passphrase }));
        expect(info.format).toBe('openssh');
        expect(info.encrypted).toBe(passphrase !== undefined);
        expect(info.keyType).toMatch(/^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa)$/);
        expect(keyTypeOfBlob(info.publicKey ?? Buffer.alloc(0))).toBe(info.keyType);
      }
    },
  );

  it('recognises PEM RSA and EC keys and whether they are encrypted', () => {
    const rsa = generateNodeKeyPair('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: {
        type: 'pkcs1',
        format: 'pem',
        cipher: 'aes-128-cbc',
        passphrase: PASSPHRASE,
      },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    }).privateKey;
    const ec = generateNodeKeyPair('ec', {
      namedCurve: 'prime256v1',
      privateKeyEncoding: { type: 'sec1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey;
    expect(inspect(rsa)).toEqual({
      format: 'pem',
      encrypted: true,
      keyType: 'ssh-rsa',
      publicKey: undefined,
    });
    expect(inspect(ec)).toEqual({
      format: 'pem',
      encrypted: false,
      keyType: undefined,
      publicKey: undefined,
    });
  });

  it('recognises a PuTTY version 2 RSA key and reads its public key', () => {
    const { text, publicKey } = ppk2(PASSPHRASE);
    expect(inspect(text)).toEqual({
      format: 'ppk2',
      encrypted: true,
      keyType: 'ssh-rsa',
      publicKey,
    });
  });

  it.each([
    [
      'PKCS#8',
      () =>
        generateNodeKeyPair('ed25519', {
          privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
          publicKeyEncoding: { type: 'spki', format: 'pem' },
        }).privateKey,
      /PKCS#8.*ssh-keygen -p/,
    ],
    [
      'encrypted PKCS#8',
      () =>
        generateNodeKeyPair('ed25519', {
          privateKeyEncoding: {
            type: 'pkcs8',
            format: 'pem',
            cipher: 'aes-256-cbc',
            passphrase: PASSPHRASE,
          },
          publicKeyEncoding: { type: 'spki', format: 'pem' },
        }).privateKey,
      /PKCS#8/,
    ],
    [
      'PuTTY version 3',
      () => 'PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nComment: x\n',
      /newer than version 2.*PuTTYgen/,
    ],
    [
      'PuTTY version 2 ed25519',
      () =>
        'PuTTY-User-Key-File-2: ssh-ed25519\nEncryption: none\nComment: x\nPublic-Lines: 1\nAAAA\n',
      /PuTTY version 2 keys of type ssh-ed25519/,
    ],
    [
      'DSA PEM',
      () => `${DASHES}BEGIN DSA PRIVATE KEY${DASHES}\nAAAA\n`,
      /DSA keys are not supported/,
    ],
    ['a public key', () => utils.generateKeyPairSync('ed25519').public, /this is a public key/],
    ['an empty file', () => '', /not a private key in a supported format/],
    ['random text', () => 'hello', /not a private key in a supported format/],
  ])('refuses %s with a clear message', (_, content, message) => {
    expectUnsupported(content(), message);
  });

  it('refuses security key (sk-) OpenSSH keys', () => {
    const publicKey = Buffer.concat([
      sshString(`sk-ssh-ed25519${OPENSSH}`),
      sshString(randomBytes(32)),
      sshString('ssh:'),
    ]);
    const text = opensshEnvelope({
      cipher: 'none',
      kdf: 'none',
      kdfOptions: Buffer.alloc(0),
      publicKey,
      privateBlob: Buffer.alloc(8),
    });
    expectUnsupported(text, /security key \(FIDO, "sk-"\) keys are not supported/);
  });

  it('refuses an OpenSSH key encrypted with a cipher it cannot decrypt', () => {
    const publicKey = Buffer.concat([sshString('ssh-ed25519'), sshString(randomBytes(32))]);
    const text = opensshEnvelope({
      cipher: `chacha20-poly1305${OPENSSH}`,
      kdf: 'bcrypt',
      kdfOptions: bcryptOptions(16),
      publicKey,
      privateBlob: Buffer.alloc(64),
      // OpenSSH appends the Poly1305 tag after the encrypted part.
      authTag: Buffer.alloc(16),
    });
    expectUnsupported(text, /chacha20-poly1305.*ssh-keygen -p/);
  });

  it(`refuses more than ${MAX_KDF_ROUNDS} bcrypt rounds`, () => {
    const publicKey = Buffer.concat([sshString('ssh-ed25519'), sshString(randomBytes(32))]);
    const text = opensshEnvelope({
      cipher: 'aes256-ctr',
      kdf: 'bcrypt',
      kdfOptions: bcryptOptions(MAX_KDF_ROUNDS + 1),
      publicKey,
      privateBlob: Buffer.alloc(64),
    });
    expectUnsupported(text, /key derivation rounds/);
  });

  it.each([
    ['an empty salt', Buffer.concat([sshString(Buffer.alloc(0)), Buffer.from([0, 0, 0, 16])])],
    ['zero rounds', bcryptOptions(0)],
    ['trailing bytes in the KDF options', Buffer.concat([bcryptOptions(16), Buffer.from([1])])],
  ])('reports %s as a damaged key', (_, kdfOptions) => {
    const publicKey = Buffer.concat([sshString('ssh-ed25519'), sshString(randomBytes(32))]);
    const text = opensshEnvelope({
      cipher: 'aes256-ctr',
      kdf: 'bcrypt',
      kdfOptions,
      publicKey,
      privateBlob: Buffer.alloc(64),
    });
    expectUnsupported(text, /damaged/);
  });

  it('refuses a damaged OpenSSH key without quoting it', () => {
    const key = opensshKey('ed25519').toString();
    const damaged = key.replace(/\n([A-Za-z0-9+/]{20})/, '\n!!$1');
    expectUnsupported(damaged, /damaged/);
    try {
      inspect(damaged);
    } catch (error) {
      expect((error as Error).message).not.toMatch(/[A-Za-z0-9+/]{20}/);
    }
  });
});

describe('decryptKeyFile', () => {
  it.each([
    ['ed25519', 'aes256-ctr'],
    ['ed25519', `aes256-gcm${OPENSSH}`],
    ['ed25519', 'aes256-cbc'],
    ['ecdsa', 'aes128-ctr'],
    ['rsa', 'aes256-ctr'],
  ] as const)('decrypts an OpenSSH %s key encrypted with %s', async (type, cipher) => {
    const content = opensshKey(type, { passphrase: PASSPHRASE, cipher });
    const reference = utils.parseKey(content, Buffer.from(PASSPHRASE));
    if (reference instanceof Error) {
      throw reference;
    }

    const key = await decryptKeyFile(content, FILE, Buffer.from(PASSPHRASE), utils, derive);

    expect(key.isPrivateKey()).toBe(true);
    expect(key.getPublicSSH().equals(reference.getPublicSSH())).toBe(true);
    const data = randomBytes(32);
    expect(reference.verify(data, key.sign(data))).toBe(true);
  });

  it.each([
    ['OpenSSH ctr', () => opensshKey('ed25519', { passphrase: PASSPHRASE })],
    [
      'OpenSSH gcm',
      () => opensshKey('ed25519', { passphrase: PASSPHRASE, cipher: `aes256-gcm${OPENSSH}` }),
    ],
    [
      'PEM RSA',
      () =>
        Buffer.from(
          generateNodeKeyPair('rsa', {
            modulusLength: 2048,
            privateKeyEncoding: {
              type: 'pkcs1',
              format: 'pem',
              cipher: 'aes-128-cbc',
              passphrase: PASSPHRASE,
            },
            publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
          }).privateKey,
        ),
    ],
    ['PuTTY version 2', () => Buffer.from(ppk2(PASSPHRASE).text)],
  ])('reports a wrong passphrase for %s without key material', async (_, make) => {
    const content = make();
    const error = await decryptKeyFile(
      content,
      FILE,
      Buffer.from('wrong-passphrase'),
      utils,
      derive,
    ).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(WrongPassphraseError);
    const message = (error as Error).message;
    expect(message).toBe(`The passphrase for ${FILE} is not correct.`);
    await expect(
      decryptKeyFile(content, FILE, Buffer.from(PASSPHRASE), utils, derive),
    ).resolves.toMatchObject({});
  });

  it('treats a missing or empty passphrase for an encrypted key as wrong', async () => {
    const content = opensshKey('ed25519', { passphrase: PASSPHRASE });
    await expect(decryptKeyFile(content, FILE, undefined, utils, derive)).rejects.toBeInstanceOf(
      WrongPassphraseError,
    );
    await expect(
      decryptKeyFile(content, FILE, Buffer.alloc(0), utils, derive),
    ).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it('reads unencrypted OpenSSH, PEM EC and PuTTY keys without a passphrase or key derivation', async () => {
    const noDerive: KeyDerivation = () => Promise.reject(new Error('must not derive'));
    const ec = generateNodeKeyPair('ec', {
      namedCurve: 'prime256v1',
      privateKeyEncoding: { type: 'sec1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey;
    for (const content of [
      opensshKey('ed25519'),
      Buffer.from(ec),
      Buffer.from(ppk2(undefined).text),
    ]) {
      const key = await decryptKeyFile(content, FILE, undefined, utils, noDerive);
      expect(key.isPrivateKey()).toBe(true);
    }
  });

  it('decrypts a PuTTY version 2 key whose public key matches', async () => {
    const { text, publicKey } = ppk2(PASSPHRASE);
    const key = await decryptKeyFile(
      Buffer.from(text),
      FILE,
      Buffer.from(PASSPHRASE),
      utils,
      derive,
    );
    expect(key.type).toBe('ssh-rsa');
    expect(key.getPublicSSH().equals(publicKey)).toBe(true);
  });

  it('does not modify the passphrase buffer it is given', async () => {
    const passphrase = Buffer.from(PASSPHRASE);
    await decryptKeyFile(
      opensshKey('ed25519', { passphrase: PASSPHRASE }),
      FILE,
      passphrase,
      utils,
      derive,
    );
    expect(passphrase.toString()).toBe(PASSPHRASE);
  });
});

describe('parsePublicKeyLine', () => {
  it('reads a .pub line and checks that the type matches the blob', () => {
    const line = utils.generateKeyPairSync('ed25519', { comment: 'deploy@example.com' }).public;
    const parsed = parsePublicKeyLine(line);
    expect(parsed?.keyType).toBe('ssh-ed25519');
    expect(parsePublicKeyLine(line.replace('ssh-ed25519', 'ssh-rsa'))).toBeUndefined();
    expect(parsePublicKeyLine('not a key')).toBeUndefined();
  });
});
