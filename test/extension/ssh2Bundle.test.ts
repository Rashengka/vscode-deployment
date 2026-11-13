import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  EXPECTED_CIPHERS,
  EXPECTED_KEX,
  probeConnection,
  type Ssh2BundleModule,
} from '../support/ssh2Probe';
import { startSshd, type SshdContainer } from '../support/sshd';
import { extensionUnderTest } from './extensionUnderTest';

// Runs in the extension host (Electron's Node.js and crypto), which is where ssh2 runs in
// production; the integration tests cover the same bundle on plain Node.js.
describe('ssh2 bundle inside the VS Code extension host', () => {
  let ssh2: Ssh2BundleModule;
  let sshd: SshdContainer | undefined;

  before(async () => {
    const bundlePath = join(extensionUnderTest().extensionPath, 'dist', 'ssh2.js');
    ssh2 = createRequire(bundlePath)(bundlePath) as Ssh2BundleModule;
    sshd = await startSshd();
  });

  after(async () => {
    await sshd?.stop();
  });

  it('loads without the native crypto binding', () => {
    assert.equal(typeof ssh2.Client, 'function');
    // With ignore-scripts the addon is never built, so this holds even for a wrong bundle; the
    // decisive guards are the require() and no-.node checks of the packaging tests.
    assert.equal(ssh2.nativeCryptoBindingAvailable, false);
  });

  it('negotiates curve25519-sha256 and AES-GCM and opens SFTP', async () => {
    assert.ok(sshd, 'The test SSH server did not start.');
    const { negotiated, remoteHome } = await probeConnection(ssh2, sshd);

    assert.equal(negotiated.kex, EXPECTED_KEX);
    assert.equal(negotiated.serverHostKey, 'ssh-ed25519');
    assert.equal(negotiated.cs.cipher, EXPECTED_CIPHERS[0]);
    assert.equal(negotiated.sc.cipher, EXPECTED_CIPHERS[0]);
    assert.equal(remoteHome, '/home/deploy');
  });
});
