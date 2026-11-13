import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  EXPECTED_CIPHERS,
  EXPECTED_KEX,
  probeConnection,
  type Ssh2BundleModule,
} from '../support/ssh2Probe';
import { startSshd, type SshdContainer } from '../support/sshd';

describe('ssh2 from the packaged bundle against a local OpenSSH server', () => {
  let sshd: SshdContainer | undefined;
  let ssh2: Ssh2BundleModule;

  beforeAll(async () => {
    const bundlePath = join(inject('unpackedExtension'), 'dist', 'ssh2.js');
    ssh2 = createRequire(bundlePath)(bundlePath) as Ssh2BundleModule;
    sshd = await startSshd();
  }, 180_000);

  afterAll(async () => {
    await sshd?.stop();
  });

  function server(): SshdContainer {
    if (sshd === undefined) {
      throw new Error('The test SSH server did not start.');
    }
    return sshd;
  }

  it('runs without the native crypto binding', () => {
    // Always true with ignore-scripts; see the require() checks in packaging.test.ts.
    expect(ssh2.nativeCryptoBindingAvailable).toBe(false);
  });

  it('negotiates curve25519-sha256 and AES-GCM and opens SFTP', async () => {
    const { negotiated, remoteHome } = await probeConnection(ssh2, server());

    expect(negotiated.kex).toBe(EXPECTED_KEX);
    expect(negotiated.serverHostKey).toBe('ssh-ed25519');
    expect(negotiated.cs.cipher).toBe(EXPECTED_CIPHERS[0]);
    expect(negotiated.sc.cipher).toBe(EXPECTED_CIPHERS[0]);
    expect(remoteHome).toBe('/home/deploy');
  });

  it('rejects the server when its host key does not match', async () => {
    const wrongKey = Buffer.from(server().hostKey);
    wrongKey[wrongKey.length - 1] = (wrongKey[wrongKey.length - 1] ?? 0) ^ 0xff;

    // ssh2 1.17.0 lib/protocol/kex.js: a hostVerifier returning false ends the handshake with
    // exactly this fatal error.
    await expect(
      probeConnection(ssh2, server(), { trustedHostKey: wrongKey }),
    ).rejects.toMatchObject({ message: 'Host denied (verification failed)', level: 'handshake' });
  });
});
