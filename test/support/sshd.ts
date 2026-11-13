/**
 * Starts a throwaway OpenSSH server in Docker for tests.
 *
 * - The image and the container are named with the `vscode-deployment-` prefix and the
 *   container is removed by name in `stop()`.
 * - The port is published on 127.0.0.1 only, on a random free host port.
 * - Host and client keys are generated inside the container at start-up and only held in
 *   memory by the test; nothing is read from or written to the user's SSH configuration.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const SSHD_IMAGE = 'vscode-deployment-test-sshd:local';
const CONTAINER_PORT = '2222/tcp';
const START_TIMEOUT_MS = 30_000;

export interface TestClientConfig {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly privateKey: string;
}

export interface SshdContainer {
  readonly name: string;
  /**
   * Host, port, user and the OpenSSH private key of the test client (unencrypted, generated
   * in the container). Host key verification and algorithms are up to the caller.
   */
  readonly clientConfig: TestClientConfig;
  /** Raw public host key blob, as passed to ssh2's `hostVerifier`. */
  readonly hostKey: Buffer;
  stop(): Promise<void>;
}

/**
 * Finds `test/support/sshd` by walking up from this file, so that the helper works both from
 * the TypeScript sources (Vitest) and from the compiled extension tests in `out/`.
 */
function findSshdContext(): string {
  for (let dir = __dirname; ; dir = dirname(dir)) {
    const candidate = join(dir, 'test', 'support', 'sshd');
    if (existsSync(join(candidate, 'Dockerfile'))) {
      return candidate;
    }
    if (dirname(dir) === dir) {
      throw new Error('Cannot find test/support/sshd/Dockerfile above ' + __dirname);
    }
  }
}

async function docker(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('docker', [...args], { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    const result = await probe();
    if (result !== undefined) {
      return result;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}.`);
    }
    await delay(200);
  }
}

/** Resolves with the SSH banner, or `undefined` when the server does not answer yet. */
async function readBanner(host: string, port: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let received = '';
    const finish = (value: string | undefined): void => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(2_000, () => {
      finish(undefined);
    });
    socket.on('error', () => {
      finish(undefined);
    });
    socket.on('close', () => {
      finish(undefined);
    });
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('latin1');
      if (received.includes('\n')) {
        finish(received.startsWith('SSH-2.0-') ? received.trim() : undefined);
      }
    });
  });
}

export async function startSshd(): Promise<SshdContainer> {
  await docker(['build', '--quiet', '--tag', SSHD_IMAGE, findSshdContext()]);

  const name = `vscode-deployment-sshd-${randomBytes(4).toString('hex')}`;
  await docker([
    'run',
    '--detach',
    '--name',
    name,
    '--label',
    'vscode-deployment.test=sshd',
    '--publish',
    `127.0.0.1::${CONTAINER_PORT}`,
    SSHD_IMAGE,
  ]);
  const stop = async (): Promise<void> => {
    await docker(['rm', '--force', name]);
  };

  try {
    const mapping = (await docker(['port', name, CONTAINER_PORT])).split('\n')[0]?.trim() ?? '';
    const port = Number(mapping.slice(mapping.lastIndexOf(':') + 1));
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`Unexpected port mapping for ${name}: "${mapping}"`);
    }
    const host = '127.0.0.1';

    await waitFor('test keys', async () => {
      const { stdout } = await execFileAsync('docker', [
        'exec',
        name,
        'sh',
        '-c',
        'test -f /run/test-keys-ready && echo ready || echo waiting',
      ]);
      return stdout.trim() === 'ready' ? true : undefined;
    });
    await waitFor('SSH banner', () => readBanner(host, port));

    const privateKey = await docker(['exec', name, 'cat', '/run/test-client/id_ed25519']);
    const hostPublicKey = await docker(['exec', name, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub']);
    const [keyType, keyData] = hostPublicKey.trim().split(/\s+/);
    if (keyType !== 'ssh-ed25519' || keyData === undefined) {
      throw new Error(`Unexpected host key format in ${name}.`);
    }

    return {
      name,
      clientConfig: { host, port, username: 'deploy', privateKey },
      hostKey: Buffer.from(keyData, 'base64'),
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
