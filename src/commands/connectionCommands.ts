/**
 * Test Connection, Disconnect, Disconnect All and the connection menu of the status bar.
 *
 * Connections are identified by their key (workspace folder and server id, see
 * `serverChoices.ts`). Everything shown from the server goes through `notificationText` or
 * `sanitizeForDisplay`; the flow itself is in `src/ui/testConnectionFlow.ts`. Nothing here
 * ever sees a passphrase: the connection manager asks for it itself.
 */
import * as vscode from 'vscode';
import { sanitizeForDisplay } from '../display/sanitize';
import type { DeploymentLog } from '../log/deploymentLog';
import type { ConnectionManager } from '../ssh/connectionManager';
import {
  ConnectionStates,
  connectionMenuItems,
  labelText,
  type ConnectionMenuAction,
} from '../ui/connectionPresentation';
import { findChoice, type SftpServerChoice } from '../ui/serverChoices';
import { SHOW_CONNECTION_MENU_COMMAND } from '../ui/statusBar';
import {
  runTestConnection,
  type TestConnectionHost,
  type TestConnectionResult,
} from '../ui/testConnectionFlow';

export type { TestConnectionResult };

export const TEST_CONNECTION_COMMAND = 'vscodeDeployment.testConnection';
export const DISCONNECT_COMMAND = 'vscodeDeployment.disconnect';
export const DISCONNECT_ALL_COMMAND = 'vscodeDeployment.disconnectAll';

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

/** Text for a QuickPick description or detail, which render `$(icon)` syntax too. */
function pickText(text: string): string {
  return labelText(text);
}

async function pickServer(
  choices: readonly SftpServerChoice[],
): Promise<SftpServerChoice | undefined> {
  if (choices.length === 1) {
    return choices[0];
  }
  const picked = await vscode.window.showQuickPick<ServerPick>(
    choices.map((choice) => {
      const { connection } = choice.server;
      return {
        label: labelText(choice.server.name),
        description: pickText(connection.sshConfigHost ?? connection.host ?? ''),
        detail: pickText(choice.folderName),
        choice,
      };
    }),
    { title: 'Test Connection', placeHolder: 'Select the server to connect to' },
  );
  return picked?.choice;
}

/**
 * The window functions Test Connection uses: a cancellable progress notification and messages
 * with a Show Log button. Shared by the command and the settings panel, so that both run the
 * same flow.
 */
export function testConnectionHost(
  connections: ConnectionManager,
  log: DeploymentLog,
  showLog: () => void,
): TestConnectionHost & { readonly connections: ConnectionManager } {
  const withShowLog = (show: Thenable<string | undefined>): void => {
    void show.then((answer) => {
      if (answer === 'Show Log') {
        showLog();
      }
    });
  };
  return {
    connections,
    log,
    withProgress: async (title, work) =>
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: true },
        (_progress, token) =>
          work((listener) => {
            token.onCancellationRequested(listener);
          }),
      ),
    showInformation: (message) => {
      withShowLog(vscode.window.showInformationMessage(message, 'Show Log'));
    },
    showError: (message) => {
      withShowLog(vscode.window.showErrorMessage(message, 'Show Log'));
    },
  };
}

export function registerConnectionCommands(
  options: ConnectionCommandsOptions,
): vscode.Disposable[] {
  const { connections, states, log } = options;

  const testConnection = async (argument?: unknown): Promise<TestConnectionResult | undefined> => {
    const choices = await options.loadServers();
    let choice: SftpServerChoice | undefined;
    if (typeof argument === 'string') {
      choice = findChoice(choices, argument);
      if (choice === undefined) {
        void vscode.window.showErrorMessage('No such SFTP server is configured.');
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
    return runTestConnection(testConnectionHost(connections, log, options.showLog), choice);
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

  /** `argument`: a connection key (as in the status bar menu). */
  const disconnect = async (argument?: unknown): Promise<void> => {
    const key = typeof argument === 'string' ? argument : await pickActive();
    if (key === undefined) {
      if (!states.anyActive()) {
        void vscode.window.showInformationMessage('Deployment: no connection is open.');
      }
      return;
    }
    const connection = states.list().find((candidate) => candidate.serverId === key);
    log.info(connection?.serverName, 'Disconnect');
    connections.disconnect(key);
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
        ...(item.description === undefined
          ? {}
          : { description: sanitizeForDisplay(item.description) }),
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
