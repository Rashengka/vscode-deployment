/**
 * Test Connection, Disconnect, Disconnect All and the connection menu of the status bar.
 *
 * Everything shown from the server (banner, home directory, error messages) goes through
 * `sanitizeForDisplay` (P9). Nothing here ever sees a passphrase: the connection manager asks
 * for it itself.
 */
import * as vscode from 'vscode';
import { sanitizeForDisplay } from '../display/sanitize';
import type { DeploymentLog } from '../log/deploymentLog';
import type { ConnectionManager } from '../ssh/connectionManager';
import { connectionFailure } from '../ui/connectionFailures';
import {
  ConnectionStates,
  connectionMenuItems,
  labelText,
  type ConnectionMenuAction,
} from '../ui/connectionPresentation';
import type { SftpServerChoice } from '../ui/serverChoices';
import { SHOW_CONNECTION_MENU_COMMAND } from '../ui/statusBar';

export const TEST_CONNECTION_COMMAND = 'vscodeDeployment.testConnection';
export const DISCONNECT_COMMAND = 'vscodeDeployment.disconnect';
export const DISCONNECT_ALL_COMMAND = 'vscodeDeployment.disconnectAll';

/** What Test Connection found; every text is already sanitized for display. */
export interface TestConnectionResult {
  readonly serverId: string;
  readonly serverName: string;
  readonly user: string;
  readonly address: string;
  readonly home: string;
  /** The login banner (multi-line), or `undefined` when the server sent none. */
  readonly banner: string | undefined;
}

export interface ConnectionCommandsOptions {
  readonly connections: ConnectionManager;
  readonly states: ConnectionStates;
  readonly log: DeploymentLog;
  readonly showLog: () => void;
  /** Loads the configured SFTP servers from disk (a fresh copy for every command). */
  readonly loadServers: () => Promise<SftpServerChoice[]>;
  readonly openConfigCommand: string;
}

interface ServerPick extends vscode.QuickPickItem {
  readonly choice: SftpServerChoice;
}

function describeTarget(choice: SftpServerChoice): string {
  const { connection } = choice.server;
  return sanitizeForDisplay(connection.sshConfigHost ?? connection.host ?? '', { maxLength: 100 });
}

async function pickServer(
  choices: readonly SftpServerChoice[],
): Promise<SftpServerChoice | undefined> {
  if (choices.length === 1) {
    return choices[0];
  }
  const picked = await vscode.window.showQuickPick<ServerPick>(
    choices.map((choice) => ({
      label: labelText(choice.server.name),
      description: describeTarget(choice),
      detail: sanitizeForDisplay(choice.folderName, { maxLength: 100 }),
      choice,
    })),
    { title: 'Test Connection', placeHolder: 'Select the server to connect to' },
  );
  return picked?.choice;
}

export function registerConnectionCommands(
  options: ConnectionCommandsOptions,
): vscode.Disposable[] {
  const { connections, states, log } = options;

  const showFailure = (message: string): void => {
    void vscode.window.showErrorMessage(message, 'Show Log').then((choice) => {
      if (choice === 'Show Log') {
        options.showLog();
      }
    });
  };

  const testConnection = async (serverId?: unknown): Promise<TestConnectionResult | undefined> => {
    const choices = await options.loadServers();
    let choice: SftpServerChoice | undefined;
    if (typeof serverId === 'string') {
      choice = choices.find((candidate) => candidate.server.id === serverId);
      if (choice === undefined) {
        void vscode.window.showErrorMessage('No SFTP server with this id is configured.');
        return undefined;
      }
    } else if (choices.length === 0) {
      const open = 'Open Config';
      const answer = await vscode.window.showErrorMessage(
        'No SFTP server is configured for this workspace.',
        open,
      );
      if (answer === open) {
        await vscode.commands.executeCommand(options.openConfigCommand);
      }
      return undefined;
    } else {
      choice = await pickServer(choices);
      if (choice === undefined) {
        return undefined;
      }
    }

    const { server, configFile } = choice;
    const name = sanitizeForDisplay(server.name, { maxLength: 100 });
    log.info(server.name, 'Test Connection', 'connecting');
    const attempt = { cancelled: false };
    let home: string;
    try {
      home = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Testing the connection to ${name}…`,
          cancellable: true,
        },
        async (_progress, token) => {
          const subscription = token.onCancellationRequested(() => {
            attempt.cancelled = true;
            connections.disconnect(server.id);
          });
          try {
            return await connections.run({ server, configFile }, (target) => target.realpath('.'));
          } finally {
            subscription.dispose();
          }
        },
      );
    } catch (error) {
      const failure = connectionFailure(error);
      if (failure === undefined) {
        log.error(server.name, 'Test Connection', error);
        throw error;
      }
      if (attempt.cancelled || failure.kind === 'cancelled') {
        log.info(server.name, 'Test Connection', 'cancelled');
        return undefined;
      }
      log.error(server.name, 'Test Connection', error);
      showFailure(`Test Connection to ${name} failed: ${sanitizeForDisplay(failure.message)}`);
      return undefined;
    }

    const details = connections.details(server.id);
    const result: TestConnectionResult = {
      serverId: server.id,
      serverName: name,
      user: sanitizeForDisplay(details?.user ?? '', { maxLength: 100 }),
      address: sanitizeForDisplay(details?.description ?? '', { maxLength: 200 }),
      home: sanitizeForDisplay(home, { maxLength: 500 }),
      banner:
        details?.banner === undefined || details.banner === ''
          ? undefined
          : sanitizeForDisplay(details.banner, { multiline: true, maxLength: 4000 }),
    };
    log.info(
      server.name,
      'Test Connection',
      `connected as ${details?.user ?? ''} (${details?.description ?? ''}), home directory ${home}`,
    );
    if (details?.banner !== undefined && details.banner !== '') {
      log.info(server.name, 'Banner', details.banner);
    }
    const message =
      `Connected to ${name} as ${result.user}. Home directory: ${result.home}.` +
      (result.banner === undefined ? '' : ' The server sent a banner; see the log.');
    void vscode.window.showInformationMessage(message, 'Show Log').then((answer) => {
      if (answer === 'Show Log') {
        options.showLog();
      }
    });
    return result;
  };

  const pickActive = async (): Promise<string | undefined> => {
    const active = states.list();
    if (active.length <= 1) {
      return active[0]?.serverId;
    }
    const picked = await vscode.window.showQuickPick(
      active.map((connection) => ({
        label: labelText(connection.serverName),
        description: connection.status,
        serverId: connection.serverId,
      })),
      { title: 'Disconnect', placeHolder: 'Select the connection to close' },
    );
    return picked?.serverId;
  };

  const disconnect = async (serverId?: unknown): Promise<void> => {
    const id = typeof serverId === 'string' ? serverId : await pickActive();
    if (id === undefined) {
      if (!states.anyActive()) {
        void vscode.window.showInformationMessage('Deployment: no connection is open.');
      }
      return;
    }
    const connection = states.list().find((candidate) => candidate.serverId === id);
    log.info(connection?.serverName, 'Disconnect');
    connections.disconnect(id);
  };

  const disconnectAll = (): void => {
    log.info(undefined, 'Disconnect All');
    connections.disconnectAll();
  };

  const run = async (action: ConnectionMenuAction): Promise<void> => {
    switch (action.kind) {
      case 'disconnect':
        await disconnect(action.serverId);
        return;
      case 'disconnectAll':
        disconnectAll();
        return;
      case 'testConnection':
        await testConnection();
        return;
    }
  };

  const showMenu = async (): Promise<void> => {
    const items = connectionMenuItems(states);
    const picked = await vscode.window.showQuickPick(
      items.map((item) => ({
        label: item.label,
        ...(item.description === undefined ? {} : { description: item.description }),
        action: item.action,
      })),
      { title: 'Deployment Connection' },
    );
    if (picked !== undefined) {
      await run(picked.action);
    }
  };

  return [
    vscode.commands.registerCommand(TEST_CONNECTION_COMMAND, testConnection),
    vscode.commands.registerCommand(DISCONNECT_COMMAND, disconnect),
    vscode.commands.registerCommand(DISCONNECT_ALL_COMMAND, disconnectAll),
    vscode.commands.registerCommand(SHOW_CONNECTION_MENU_COMMAND, showMenu),
  ];
}
