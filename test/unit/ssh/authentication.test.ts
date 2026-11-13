import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAuthMethod, BaseAgent, ParsedKey } from 'ssh2';
import {
  Sha1SignatureRefusedError,
  createAuthHandler,
  disposeIdentities,
  isSha1Signature,
  loadIdentities,
  refuseSha1Signatures,
  type AuthenticationContext,
  type Identity,
} from '../../../src/ssh/authentication';
import { ConnectionAttemptEndedError } from '../../../src/ssh/passphrase';
import { UnsupportedKeyError } from '../../../src/ssh/privateKey';
import { readRegularFile } from '../../../src/ssh/sshConfigFiles';
import { BaseAgent as Ssh2BaseAgent, utils } from '../../../src/ssh/ssh2Bundle';

function sshString(value: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length);
  return Buffer.concat([length, value]);
}

function mpint(value: Buffer): Buffer {
  return sshString((value[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value);
}

describe('loadIdentities', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function dir(): string {
    const created = mkdtempSync(join(tmpdir(), 'vscode-deployment-keys-'));
    dirs.push(created);
    return created;
  }

  const readText = (path: string): Promise<string | undefined> => readRegularFile(path);

  it('skips missing default keys quietly', async () => {
    const keys = dir();
    const pair = utils.generateKeyPairSync('ed25519');
    writeFileSync(join(keys, 'id_rsa'), pair.private, { mode: 0o600 });

    const { identities, skipped } = await loadIdentities(
      [join(keys, 'id_ed25519'), join(keys, 'id_ecdsa'), join(keys, 'id_rsa')],
      true,
      readText,
    );

    expect(identities.map((identity) => identity.file)).toEqual([join(keys, 'id_rsa')]);
    expect(
      identities[0]?.publicKey?.equals(Buffer.from(pair.public.split(' ')[1] ?? '', 'base64')),
    ).toBe(true);
    expect(skipped).toEqual([]);
    disposeIdentities(identities);
    expect(identities[0]?.content.every((byte) => byte === 0)).toBe(true);
  });

  it('fails for a missing or unsupported key that was configured explicitly', async () => {
    const keys = dir();
    await expect(loadIdentities([join(keys, 'missing')], false, readText)).rejects.toThrow(
      /identity file does not exist/,
    );
    const pkcs8 = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey;
    writeFileSync(join(keys, 'id_pkcs8'), pkcs8, { mode: 0o600 });
    await expect(loadIdentities([join(keys, 'id_pkcs8')], false, readText)).rejects.toBeInstanceOf(
      UnsupportedKeyError,
    );
    // As a default key it is skipped with the reason instead.
    const { identities, skipped } = await loadIdentities([join(keys, 'id_pkcs8')], true, readText);
    expect(identities).toEqual([]);
    expect(skipped[0]?.reason).toMatch(/PKCS#8/);
  });

  it('takes the public key of a PEM key from the .pub file next to it', async () => {
    const keys = dir();
    const pem = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem', cipher: 'aes-128-cbc', passphrase: 'x' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const jwk = createPublicKey(pem.publicKey).export({ format: 'jwk' });
    const blob = Buffer.concat([
      sshString(Buffer.from('ssh-rsa')),
      mpint(Buffer.from(jwk.e ?? '', 'base64url')),
      mpint(Buffer.from(jwk.n ?? '', 'base64url')),
    ]);
    writeFileSync(join(keys, 'id_rsa'), pem.privateKey, { mode: 0o600 });

    const without = await loadIdentities([join(keys, 'id_rsa')], false, readText);
    expect(without.identities[0]?.publicKey).toBeUndefined();
    expect(without.identities[0]?.encrypted).toBe(true);

    writeFileSync(
      join(keys, 'id_rsa.pub'),
      `ssh-rsa ${blob.toString('base64')} deploy@example.com\n`,
    );
    const withPub = await loadIdentities([join(keys, 'id_rsa')], false, readText);
    expect(withPub.identities[0]?.publicKey?.equals(blob)).toBe(true);

    // A .pub of another key type is not used.
    writeFileSync(join(keys, 'id_rsa.pub'), utils.generateKeyPairSync('ed25519').public);
    const mismatched = await loadIdentities([join(keys, 'id_rsa')], false, readText);
    expect(mismatched.identities[0]?.publicKey).toBeUndefined();
  });
});

function parsed(text: string, passphrase?: string): ParsedKey {
  const key = utils.parseKey(text, passphrase === undefined ? undefined : Buffer.from(passphrase));
  if (key instanceof Error) {
    throw key;
  }
  return key;
}

function context(patch: Partial<AuthenticationContext>): AuthenticationContext {
  return {
    username: 'deploy',
    target: 'deploy@example.com:22',
    identities: [],
    agentSocket: undefined,
    identitiesOnly: false,
    prompt: () => Promise.reject(new Error('no prompt expected')),
    parser: utils,
    deriveKey: () => Promise.reject(new Error('no key derivation expected')),
    BaseAgent: Ssh2BaseAgent,
    createAgent: () => {
      throw new Error('no agent expected');
    },
    onFatalError: () => undefined,
    signal: new AbortController().signal,
    onAuthenticationStarted: () => undefined,
    localWork: (work) => work(),
    ...patch,
  };
}

/** Asks the handler for its next method. */
function nextMethod(handler: ReturnType<typeof createAuthHandler>['handler']): Promise<unknown> {
  return new Promise((resolve) => {
    handler(['publickey'], false, resolve);
  });
}

describe('SHA-1 user authentication signatures', () => {
  it('recognises SHA-1 requests', () => {
    expect(isSha1Signature('ssh-rsa', 'sha1')).toBe(true);
    expect(isSha1Signature('ssh-rsa', undefined)).toBe(true);
    expect(isSha1Signature('ssh-rsa', 'sha256')).toBe(false);
    expect(isSha1Signature('ssh-rsa', 'sha512')).toBe(false);
    expect(isSha1Signature('ssh-ed25519', undefined)).toBe(false);
  });

  it('makes a parsed RSA key refuse SHA-1 but still sign with SHA-2', () => {
    const key = refuseSha1Signatures(
      parsed(utils.generateKeyPairSync('rsa', { bits: 2048 }).private),
      '/home/deploy/.ssh/id_rsa',
    );
    const data = Buffer.from('data');
    expect(key.sign(data, 'sha1')).toBeInstanceOf(Sha1SignatureRefusedError);
    expect(key.sign(data)).toBeInstanceOf(Sha1SignatureRefusedError);
    const signature = key.sign(data, 'sha256');
    expect(signature).toBeInstanceOf(Buffer);
    expect(key.verify(data, signature, 'sha256')).toBe(true);
  });

  it('refuses a SHA-1 signature in the identity file agent without asking for the passphrase', async () => {
    const pair = utils.generateKeyPairSync('rsa', {
      bits: 2048,
      passphrase: 'p',
      cipher: 'aes256-ctr',
      rounds: 4,
    });
    const publicKey = parsed(pair.public);
    const identity: Identity = {
      file: '/home/deploy/.ssh/id_rsa',
      encrypted: true,
      publicKey: publicKey.getPublicSSH(),
      content: Buffer.from(pair.private),
    };
    let prompts = 0;
    const { handler } = createAuthHandler(
      context({
        identities: [identity],
        prompt: () => {
          prompts += 1;
          return Promise.resolve(Buffer.from('p'));
        },
      }),
    );
    const method = (await nextMethod(handler)) as AgentAuthMethod;
    const agent = method.agent as BaseAgent;

    const error = await new Promise<Error | null | undefined>((resolve) => {
      agent.sign(publicKey, Buffer.from('data'), { hash: 'sha1' }, (signError) => {
        resolve(signError);
      });
    });

    expect(error).toBeInstanceOf(Sha1SignatureRefusedError);
    expect(prompts).toBe(0);
  });
});

describe('after the connection attempt ended', () => {
  it.each([true, false])(
    'never prompts or signs when the server asks to sign (encrypted: %s)',
    async (encrypted) => {
      const pair = encrypted
        ? utils.generateKeyPairSync('ed25519', { passphrase: 'p', cipher: 'aes256-ctr', rounds: 4 })
        : utils.generateKeyPairSync('ed25519');
      const publicKey = parsed(pair.public);
      const abort = new AbortController();
      let prompts = 0;
      const { handler } = createAuthHandler(
        context({
          identities: [
            {
              file: '/home/deploy/.ssh/id_ed25519',
              encrypted,
              publicKey: publicKey.getPublicSSH(),
              content: Buffer.from(pair.private),
            },
          ],
          signal: abort.signal,
          prompt: () => {
            prompts += 1;
            return Promise.resolve(Buffer.from('p'));
          },
        }),
      );
      const method = (await nextMethod(handler)) as AgentAuthMethod;
      abort.abort();

      const error = await new Promise<Error | null | undefined>((resolve) => {
        (method.agent as BaseAgent).sign(publicKey, Buffer.from('data'), {}, (signError) => {
          resolve(signError);
        });
      });

      expect(error).toBeInstanceOf(ConnectionAttemptEndedError);
      expect(prompts).toBe(0);
    },
  );
});

describe('IdentitiesOnly with the SSH agent', () => {
  it('offers only agent keys that belong to an identity file', async () => {
    const own = utils.generateKeyPairSync('ed25519');
    const other = utils.generateKeyPairSync('ed25519');
    const ownPublic = parsed(own.public);
    class FakeAgent extends Ssh2BaseAgent {
      getIdentities(callback: (error: Error | null, keys?: ParsedKey[]) => void): void {
        callback(null, [parsed(other.public), ownPublic]);
      }
      sign(): void {
        throw new Error('not used');
      }
    }
    const identity: Identity = {
      file: '/home/deploy/.ssh/id_ed25519',
      encrypted: false,
      publicKey: ownPublic.getPublicSSH(),
      content: Buffer.from(own.private),
    };
    const { handler } = createAuthHandler(
      context({
        identities: [identity],
        agentSocket: '/run/agent.sock',
        identitiesOnly: true,
        createAgent: () => new FakeAgent(),
      }),
    );
    const method = (await nextMethod(handler)) as AgentAuthMethod;

    const offered = await new Promise<ParsedKey[]>((resolve, reject) => {
      (method.agent as BaseAgent).getIdentities((error, keys) => {
        if (error) {
          reject(error);
        } else {
          resolve((keys ?? []) as ParsedKey[]);
        }
      });
    });

    expect(offered.map((key) => key.getPublicSSH().toString('base64'))).toEqual([
      ownPublic.getPublicSSH().toString('base64'),
    ]);
  });
});
