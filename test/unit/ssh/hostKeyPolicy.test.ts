import { describe, expect, it } from 'vitest';
import {
  HostKeyRejectedError,
  hostKeyPolicy,
  readKnownHostsFiles,
  sshCommandFor,
  type HostKeyTarget,
} from '../../../src/ssh/hostKeyPolicy';
import { parseKnownHosts, sha256Fingerprint } from '../../../src/ssh/knownHosts';
import { supportedServerHostKeyAlgorithms, utils } from '../../../src/ssh/ssh2Bundle';

function publicKey(type: 'ed25519' | 'ecdsa' | 'rsa'): { line: string; blob: Buffer } {
  const options = type === 'rsa' ? { bits: 2048 } : type === 'ecdsa' ? { bits: 256 } : {};
  const line = utils.generateKeyPairSync(type, options as never).public.trim();
  return { line, blob: Buffer.from(line.split(' ')[1] ?? '', 'base64') };
}

const ed25519 = publicKey('ed25519');
const ecdsa = publicKey('ecdsa');
const rsa = publicKey('rsa');
const FILE = '/home/deploy/.ssh/known_hosts';
const target: HostKeyTarget = {
  alias: 'production',
  hostName: 'app.example.com',
  port: 22,
  user: 'deploy',
};

function policy(knownHosts: string, name = 'app.example.com'): ReturnType<typeof hostKeyPolicy> {
  return hostKeyPolicy(
    [parseKnownHosts(knownHosts, FILE)],
    [FILE],
    name,
    target,
    supportedServerHostKeyAlgorithms,
  );
}

function rejection(result: HostKeyRejectedError | undefined): HostKeyRejectedError {
  expect(result).toBeInstanceOf(HostKeyRejectedError);
  return result as HostKeyRejectedError;
}

describe('hostKeyPolicy', () => {
  it('trusts the listed key and offers only its signature algorithms', () => {
    const checked = policy(`app.example.com ${ecdsa.line}\n`);
    expect(checked.algorithms).toEqual(['ecdsa-sha2-nistp256']);
    expect(checked.check(ecdsa.blob)).toBeUndefined();
  });

  it('offers RSA only with SHA-2 signatures', () => {
    expect(policy(`app.example.com ${rsa.line}\n`).algorithms).toEqual([
      'rsa-sha2-512',
      'rsa-sha2-256',
    ]);
  });

  it('rejects an unknown host with the fingerprint and how to accept it with ssh', () => {
    const checked = policy(`other.example.com ${ed25519.line}\n`);
    // Every supported type is offered only to learn the fingerprint for the message.
    expect(checked.algorithms).toContain('ssh-ed25519');
    expect(checked.algorithms).not.toContain('ssh-rsa');
    const error = rejection(checked.check(ed25519.blob));
    expect(error.problem).toBe('unknown');
    expect(error.fingerprint).toBe(sha256Fingerprint(ed25519.blob));
    expect(error.message).toContain(error.fingerprint);
    expect(error.message).toContain('"ssh production"');
    expect(error.message).toContain(FILE);
    expect(error.message).toContain('never adds keys');
  });

  it('rejects a changed key with a man-in-the-middle warning and no way around it', () => {
    const error = rejection(
      policy(`app.example.com ${ed25519.line}\n`).check(publicKey('ed25519').blob),
    );
    expect(error.problem).toBe('changed');
    expect(error.message).toMatch(/^WARNING: the host key of app\.example\.com has changed/);
    expect(error.message).toContain('possible man-in-the-middle');
    expect(error.message).toContain('Verify the server key with the server administrator');
    expect(error.message).toContain(`${FILE}:1`);
    expect(error.message).not.toMatch(/ssh-keygen -R|remove|delete|trust anyway|"ssh /i);
  });

  it('rejects a revoked key even when it is also listed for the host', () => {
    const error = rejection(
      policy(
        `app.example.com ${ed25519.line}\napp.example.com ${ecdsa.line}\n@revoked * ${ed25519.line}\n`,
      ).check(ed25519.blob),
    );
    expect(error.problem).toBe('revoked');
    expect(error.message).toContain(`${FILE}:3`);
  });

  it('uses [host]:port names for other ports', () => {
    expect(
      policy(`[app.example.com]:2222 ${ed25519.line}\n`, '[app.example.com]:2222').check(
        ed25519.blob,
      ),
    ).toBe(undefined);
  });
});

describe('sshCommandFor', () => {
  it('advises the alias, or user, host and port for a manual connection', () => {
    expect(sshCommandFor(target)).toBe('ssh production');
    expect(sshCommandFor({ ...target, alias: undefined })).toBe('ssh deploy@app.example.com');
    expect(sshCommandFor({ ...target, alias: undefined, port: 2222 })).toBe(
      'ssh -p 2222 deploy@app.example.com',
    );
  });
});

describe('readKnownHostsFiles', () => {
  it('skips missing files and parses the others', async () => {
    const files: Record<string, string> = { '/a': `app.example.com ${ed25519.line}\n` };
    const parsed = await readKnownHostsFiles(['/missing', '/a'], (path) =>
      Promise.resolve(files[path]),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.entries).toHaveLength(1);
  });
});
