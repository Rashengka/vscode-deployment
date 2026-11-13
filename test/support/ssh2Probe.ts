/**
 * Connects with the ssh2 build shipped in the package to a test OpenSSH server and reports
 * what was negotiated. Shared by the Node.js integration test and the VS Code extension test.
 */
import type { CipherAlgorithm, NegotiatedAlgorithms } from 'ssh2';
import type * as Ssh2Bundle from '../../src/ssh/ssh2Bundle';
import type { SshdContainer } from './sshd';

export type Ssh2BundleModule = typeof Ssh2Bundle;

const OPENSSH_SUFFIX = '@' + 'openssh.com';

/** Algorithms the extension relies on without the native addon. */
export const EXPECTED_KEX = 'curve25519-sha256';
export const EXPECTED_CIPHERS: readonly CipherAlgorithm[] = [
  `aes256-gcm${OPENSSH_SUFFIX}` as CipherAlgorithm,
  `aes128-gcm${OPENSSH_SUFFIX}` as CipherAlgorithm,
];
export const CHACHA20_CIPHER = `chacha20-poly1305${OPENSSH_SUFFIX}` as CipherAlgorithm;

export interface ProbeResult {
  readonly negotiated: NegotiatedAlgorithms;
  readonly remoteHome: string;
}

export interface ProbeOptions {
  readonly ciphers?: readonly CipherAlgorithm[];
  /** Host key the client accepts; defaults to the real key of the test server. */
  readonly trustedHostKey?: Buffer;
}

export async function probeConnection(
  ssh2: Ssh2BundleModule,
  sshd: SshdContainer,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const trustedHostKey = options.trustedHostKey ?? sshd.hostKey;
  const client = new ssh2.Client();
  try {
    return await new Promise<ProbeResult>((resolve, reject) => {
      let negotiated: NegotiatedAlgorithms | undefined;
      client.on('handshake', (algorithms) => {
        negotiated = algorithms;
      });
      client.on('error', reject);
      client.on('close', () => {
        reject(new Error('Connection closed before the probe finished.'));
      });
      client.on('ready', () => {
        client.sftp((sftpError, sftp) => {
          if (sftpError !== undefined) {
            reject(sftpError);
            return;
          }
          sftp.realpath('.', (realpathError, remoteHome) => {
            if (realpathError !== undefined) {
              reject(realpathError);
            } else if (negotiated === undefined) {
              reject(new Error('Handshake event was not emitted.'));
            } else {
              resolve({ negotiated, remoteHome });
            }
          });
        });
      });
      client.connect({
        ...sshd.clientConfig,
        hostVerifier: (key: Buffer) => key.equals(trustedHostKey),
        algorithms: {
          kex: [EXPECTED_KEX],
          cipher: [...(options.ciphers ?? EXPECTED_CIPHERS)],
          serverHostKey: ['ssh-ed25519'],
        },
        readyTimeout: 20_000,
      });
    });
  } finally {
    client.end();
  }
}
