/**
 * Test Connection without the VS Code API (the command in `src/commands/connectionCommands.ts`
 * passes the window functions in), so that cancellation and messages can be tested on their own.
 *
 * Messages: notifications get only short, neutralized text (`notificationText`); the full text
 * from the server goes to the Deployment log, which sanitizes it too. An error that is not one
 * of the expected connection failures is a bug: the notification says so without its message,
 * which is logged.
 */
import { sanitizeForDisplay } from '../display/sanitize';
import type { DeploymentLog } from '../log/deploymentLog';
import type { ConnectionManager } from '../ssh/connectionManager';
import { runCancellable } from './cancellableOperation';
import { notificationText } from './notifications';
import type { SftpServerChoice } from './serverChoices';

/** What Test Connection found; every text is already sanitized for display. */
export interface TestConnectionResult {
  /** The connection key (folder and server id). */
  readonly key: string;
  readonly serverId: string;
  readonly serverName: string;
  readonly user: string;
  readonly address: string;
  readonly home: string;
  /** The login banner (multi-line), or `undefined` when the server sent none. */
  readonly banner: string | undefined;
}

export interface TestConnectionHost {
  readonly connections: Pick<ConnectionManager, 'run' | 'status' | 'disconnect' | 'details'>;
  readonly log: DeploymentLog;
  /**
   * Runs `work` while a cancellable progress notification is shown; `work` registers what to do
   * when the user cancels.
   */
  withProgress<T>(
    title: string,
    work: (onCancel: (listener: () => void) => void) => Promise<T>,
  ): Promise<T>;
  showInformation(message: string): void;
  showError(message: string): void;
}

export async function runTestConnection(
  host: TestConnectionHost,
  choice: SftpServerChoice,
): Promise<TestConnectionResult | undefined> {
  const { connections, log } = host;
  const { server, configFile, key } = choice;
  const name = notificationText(server.name, 100);
  log.info(server.name, 'Test Connection', 'connecting');
  const outcome = await runCancellable(
    host,
    connections,
    key,
    `Testing the connection to ${name}…`,
    () => connections.run({ server, configFile, key }, (target) => target.realpath('.')),
  );
  switch (outcome.kind) {
    case 'cancelled':
      log.info(server.name, 'Test Connection', 'cancelled');
      return undefined;
    case 'unexpected':
      log.error(server.name, 'Test Connection (unexpected error)', outcome.error);
      host.showError(
        `Test Connection to ${name} failed because of an unexpected error. ` +
          'The details are in the Deployment log.',
      );
      return undefined;
    case 'failed':
      log.error(server.name, 'Test Connection', outcome.error);
      host.showError(`Test Connection to ${name} failed: ${notificationText(outcome.message)}`);
      return undefined;
    case 'done':
      break;
  }
  const home = outcome.value;

  const details = connections.details(key);
  const user = details?.user ?? '';
  const address = details?.description ?? '';
  const banner =
    details?.banner === undefined || details.banner === '' ? undefined : details.banner;
  log.info(
    server.name,
    'Test Connection',
    `connected as ${user} (${address}), home directory ${home}`,
  );
  if (banner !== undefined) {
    log.info(server.name, 'Banner', banner);
  }
  host.showInformation(
    `Connected to ${name} as ${notificationText(user, 100)}. ` +
      `Home directory: ${notificationText(home, 200)}.` +
      (banner === undefined ? '' : ' The server sent a banner; see the Deployment log.'),
  );
  return {
    key,
    serverId: server.id,
    serverName: sanitizeForDisplay(server.name, { maxLength: 100 }),
    user: sanitizeForDisplay(user, { maxLength: 100 }),
    address: sanitizeForDisplay(address, { maxLength: 200 }),
    home: sanitizeForDisplay(home, { maxLength: 500 }),
    banner:
      banner === undefined
        ? undefined
        : sanitizeForDisplay(banner, { multiline: true, maxLength: 4000 }),
  };
}
