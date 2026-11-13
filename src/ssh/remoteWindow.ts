/**
 * Connections are refused in remote windows (Remote - SSH, WSL, Dev Containers, Codespaces).
 * There the extension host runs on the remote machine, so key files, known_hosts and the
 * decrypted key would be read and held on that machine instead of the local one.
 */

export class RemoteWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteWindowError';
  }
}

/**
 * The message to show when connecting must be refused, or `undefined` in a local window.
 * `remoteName` is `vscode.env.remoteName` (for example `ssh-remote`, `wsl`).
 */
export function remoteWindowRefusal(remoteName: string | undefined): string | undefined {
  if (remoteName === undefined || remoteName === '') {
    return undefined;
  }
  return (
    `Deployment connections are not available in a remote window (${remoteName}). ` +
    'The extension would run on the remote machine and read SSH keys and known_hosts there. ' +
    'Open the project in a local window to deploy.'
  );
}
