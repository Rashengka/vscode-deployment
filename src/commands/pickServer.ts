/** The QuickPicks that ask which SFTP server a command should use. */
import * as vscode from 'vscode';
import { labelText } from '../ui/connectionPresentation';
import { deploymentPickItem, selectDeploymentServer } from '../ui/deploymentServer';
import type { SftpServerChoice } from '../ui/serverChoices';

interface ServerPick extends vscode.QuickPickItem {
  readonly choice: SftpServerChoice;
}

/** `choices[0]` when it is the only one; otherwise the user's pick (`undefined`: cancelled). */
export async function pickServer(
  choices: readonly SftpServerChoice[],
  title: string,
  placeHolder: string,
): Promise<SftpServerChoice | undefined> {
  if (choices.length === 1) {
    return choices[0];
  }
  const picked = await vscode.window.showQuickPick<ServerPick>(
    choices.map((choice) => {
      const { connection } = choice.server;
      return {
        // QuickPick descriptions and details render `$(icon)` syntax too.
        label: labelText(choice.server.name),
        description: labelText(connection.sshConfigHost ?? connection.host ?? ''),
        detail: labelText(choice.folderName),
        choice,
      };
    }),
    { title, placeHolder },
  );
  return picked?.choice;
}

/**
 * The server a deployment command (Compare with Deployed Version, upload) uses: the default
 * one or the only one without asking, otherwise the user's pick. `undefined` when the user
 * cancels; `null` when no server can be deployed to.
 */
export async function chooseDeploymentServer(
  choices: readonly SftpServerChoice[],
  title: string,
): Promise<SftpServerChoice | undefined | null> {
  const selection = selectDeploymentServer(choices);
  switch (selection.kind) {
    case 'none':
      return null;
    case 'chosen':
      return selection.choice;
    case 'pick': {
      const picked = await vscode.window.showQuickPick(
        selection.choices.map((choice) => ({ ...deploymentPickItem(choice), choice })),
        { title, placeHolder: 'Select the server' },
      );
      return picked?.choice;
    }
  }
}
