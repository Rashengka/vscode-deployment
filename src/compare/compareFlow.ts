/**
 * Compare with Deployed Version without the VS Code API (the command in
 * `src/commands/compareCommand.ts` passes the window functions in), so that every decision and
 * message can be tested on its own.
 *
 * Nothing is downloaded for a file outside the project, outside every mapping or excluded. The
 * file on the server is checked with `lstat` and read with the size limit (`fetch.ts`); only a
 * text file is shown, in a diff with the local file. Messages are built like those of Test
 * Connection: short, neutralized text in notifications, the details in the Deployment log.
 */
import { sanitizeForDisplay } from '../display/sanitize';
import type { DeploymentLog } from '../log/deploymentLog';
import type { ConnectionManager } from '../ssh/connectionManager';
import { localFileTarget } from '../mapping/target';
import { runCancellable, type ProgressHost } from '../ui/cancellableOperation';
import { notificationText } from '../ui/notifications';
import type { SftpServerChoice } from '../ui/serverChoices';
import { fetchDeployedVersion, MAX_COMPARE_BYTES, type DeployedVersion } from './fetch';

const COMMAND = 'Compare with Deployed Version';

export interface CompareRequest {
  readonly choice: SftpServerChoice;
  /** Canonical path of the workspace folder the server is configured for. */
  readonly projectDir: string;
  /** Canonical path of the local file (used to find it in the mappings). */
  readonly localFile: string;
  /** The name of the file as the user chose it (shown in messages and the diff title). */
  readonly displayName: string;
  readonly platform: NodeJS.Platform;
}

/** The deployed version to show on the left side of the diff. */
export interface OpenedDocument {
  /** Absolute path on the server. */
  readonly path: string;
  readonly content: Buffer;
  /** Modification time on the server, in milliseconds since the epoch. */
  readonly mtimeMs: number;
}

export interface CompareHost extends ProgressHost {
  readonly connections: Pick<ConnectionManager, 'run' | 'status' | 'disconnect'>;
  readonly log: DeploymentLog;
  showInformation(message: string): void;
  showWarning(message: string): void;
  showError(message: string): void;
  /** Opens the diff of `document` (left) and the local file (right). */
  openDiff(document: OpenedDocument, title: string): Promise<void>;
}

export type CompareOutcome =
  | 'opened'
  /** The local file is missing or is not a regular file. */
  | 'localNotFile'
  | 'outside'
  | 'unmapped'
  | 'excluded'
  | Exclude<DeployedVersion['kind'], 'text'>
  | 'failed'
  | 'cancelled';

export interface CompareResult {
  readonly outcome: CompareOutcome;
  /** The diff editor's title, when it was opened. */
  readonly title?: string;
  /** The file on the server, when the file is mapped. */
  readonly remotePath?: string;
}

/** `<file> (<server>) ↔ Local`, as plain text (editor titles render no Markdown). */
export function diffTitle(fileName: string, serverName: string): string {
  return `${sanitizeForDisplay(fileName, { maxLength: 200 })} (${sanitizeForDisplay(serverName, {
    maxLength: 100,
  })}) ↔ Local`;
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export async function runCompare(
  host: CompareHost,
  request: CompareRequest,
): Promise<CompareResult> {
  const { connections, log } = host;
  const { server, configFile, key } = request.choice;
  const serverName = notificationText(server.name, 100);
  const fileName = request.displayName;
  const file = notificationText(fileName, 200);

  const target = localFileTarget(server, request.projectDir, request.localFile, request.platform);
  switch (target.kind) {
    case 'outside':
      host.showWarning(
        `${file} is not inside the project folder ${notificationText(request.choice.folderName, 100)}.`,
      );
      return { outcome: 'outside' };
    case 'outsideRoot':
      host.showWarning(`${file} would be outside the root path of ${serverName} on the server.`);
      return { outcome: 'outside' };
    case 'unmapped':
      host.showWarning(`${file} is not in any mapping of ${serverName}.`);
      return { outcome: 'unmapped' };
    case 'excluded':
      host.showWarning(`${file} is excluded from deployment to ${serverName}.`);
      return { outcome: 'excluded' };
    case 'ok':
      break;
  }
  const { remotePath } = target;

  log.info(server.name, COMMAND, remotePath);
  const outcome = await runCancellable(
    host,
    connections,
    key,
    `Downloading ${file} from ${serverName}…`,
    (signal) =>
      connections.run({ server, configFile, key }, (remote) =>
        fetchDeployedVersion(remote, remotePath, MAX_COMPARE_BYTES, signal),
      ),
  );
  switch (outcome.kind) {
    case 'cancelled':
      log.info(server.name, COMMAND, 'cancelled');
      return { outcome: 'cancelled', remotePath };
    case 'unexpected':
      log.error(server.name, `${COMMAND} (unexpected error)`, outcome.error);
      host.showError(
        `${COMMAND} of ${file} failed because of an unexpected error. ` +
          'The details are in the Deployment log.',
      );
      return { outcome: 'failed', remotePath };
    case 'failed':
      log.error(server.name, COMMAND, outcome.error);
      host.showError(`${COMMAND} of ${file} failed: ${notificationText(outcome.message)}`);
      return { outcome: 'failed', remotePath };
    case 'done':
      break;
  }
  const version = outcome.value;

  switch (version.kind) {
    case 'missing':
      log.info(server.name, COMMAND, `${remotePath} does not exist`);
      host.showWarning(`File does not exist on ${serverName}`);
      return { outcome: 'missing', remotePath };
    case 'symlink':
      log.warn(server.name, COMMAND, `${remotePath} is a symbolic link; not followed`);
      host.showWarning(
        `${file} on ${serverName} is a symbolic link. ${COMMAND} does not follow links on the server.`,
      );
      return { outcome: 'symlink', remotePath };
    case 'notFile':
      log.warn(server.name, COMMAND, `${remotePath} is not a regular file (${version.type})`);
      host.showWarning(`${file} on ${serverName} is not a regular file.`);
      return { outcome: 'notFile', remotePath };
    case 'tooLarge':
      log.warn(server.name, COMMAND, `${remotePath} is larger than ${version.maxBytes} bytes`);
      host.showWarning(
        `${file} on ${serverName} is larger than ${megabytes(version.maxBytes)}. ` +
          `${COMMAND} compares files up to ${megabytes(version.maxBytes)}.`,
      );
      return { outcome: 'tooLarge', remotePath };
    case 'binary':
      log.info(server.name, COMMAND, `${remotePath} is a binary file (${version.size} bytes)`);
      host.showInformation(
        `${file} on ${serverName} is a binary file. ${COMMAND} shows text files only.`,
      );
      return { outcome: 'binary', remotePath };
    case 'text':
      break;
  }

  const title = diffTitle(fileName, server.name);
  await host.openDiff(
    { path: remotePath, content: version.content, mtimeMs: version.stat.mtime * 1000 },
    title,
  );
  log.info(server.name, COMMAND, `${remotePath}: opened (${version.content.length} bytes)`);
  return { outcome: 'opened', title, remotePath };
}
