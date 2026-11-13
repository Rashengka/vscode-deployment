/**
 * VS Code side of the connection manager: the passphrase input box, the environment of the
 * extension host and the location of the bundled ssh2 and key derivation worker. All logic
 * lives in `src/ssh/`; this file only connects it to VS Code.
 */
import { createRequire } from 'node:module';
import { homedir, userInfo } from 'node:os';
import { basename, join } from 'node:path';
import * as vscode from 'vscode';
import { ConnectionManager, type Ssh2Module } from '../ssh/connectionManager';
import type { SshEnvironment } from '../ssh/connectionTarget';
import { nodeFileWatcher } from '../ssh/fileWatcher';
import { workerKeyDerivation } from '../ssh/keyDerivation';
import type { PassphrasePrompt } from '../ssh/passphrase';
import { nodeFileAccess } from '../ssh/sshConfigFiles';

/**
 * Asks for a passphrase in a password input box. The text is turned into a Buffer right away;
 * it is never logged, stored or put anywhere else.
 */
export const vscodePassphrasePrompt: PassphrasePrompt = async (request) => {
  const retry = request.previousAttemptFailed
    ? `Wrong passphrase (attempt ${request.attempt} of ${request.maxAttempts}). `
    : '';
  // Closes the input box when the connection attempt ends (Disconnect, timeout, failure).
  const cancellation = new vscode.CancellationTokenSource();
  const onAbort = (): void => {
    cancellation.cancel();
  };
  request.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const value = await vscode.window.showInputBox(
      {
        title: `Passphrase for ${basename(request.keyFile)}`,
        prompt: `${retry}Enter the passphrase for ${request.keyFile} to connect to ${request.target}.`,
        password: true,
        ignoreFocusOut: true,
      },
      cancellation.token,
    );
    return value === undefined ? undefined : Buffer.from(value, 'utf8');
  } finally {
    request.signal.removeEventListener('abort', onAbort);
    cancellation.dispose();
  }
};

function environment(): SshEnvironment {
  return {
    homeDirectory: homedir(),
    localUser: userInfo().username,
    agentSocket: process.env['SSH_AUTH_SOCK'],
    remoteName: vscode.env.remoteName,
    ...nodeFileAccess,
  };
}

/** The connection manager of the running extension. */
export function createConnectionManager(extensionPath: string): ConnectionManager {
  const ssh2Bundle = join(extensionPath, 'dist', 'ssh2.js');
  return new ConnectionManager({
    // Loaded on the first connection only, so that activation stays fast.
    ssh2: () => createRequire(ssh2Bundle)(ssh2Bundle) as Ssh2Module,
    environment,
    prompt: vscodePassphrasePrompt,
    deriveKey: workerKeyDerivation(join(extensionPath, 'dist', 'kdfWorker.js')),
    watcher: nodeFileWatcher,
  });
}
