/**
 * Compare with Deployed Version: the command (editor, editor tab, Explorer, Command Palette)
 * and {@link DeployedVersionCompare.compareFile}, which the upload confirmation uses to compare
 * one file with a server it already chose.
 *
 * The flow itself is in `src/compare/compareFlow.ts`; this file finds the file and the server,
 * and opens the diff with the deployed version served by the read-only
 * `vscode-deployment-remote:` file system (`src/compare/remoteFileSystem.ts`).
 */
import { realpath, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import * as vscode from 'vscode';
import {
  runCompare,
  type CompareHost,
  type CompareResult,
  type OpenedDocument,
} from '../compare/compareFlow';
import { REMOTE_SCHEME, type RemoteDocuments } from '../compare/documents';
import type { FoldersSnapshot } from '../config/folders';
import type { DeploymentLog } from '../log/deploymentLog';
import type { ConnectionManager } from '../ssh/connectionManager';
import { notificationText } from '../ui/notifications';
import {
  choicesOfFolder,
  configuredSftpServers,
  connectionKey,
  type SftpServerChoice,
} from '../ui/serverChoices';
import { chooseDeploymentServer } from './pickServer';

export const COMPARE_COMMAND = 'vscodeDeployment.compareWithDeployed';

const COMMAND_TITLE = 'Compare with Deployed Version';

export interface CompareOptions {
  readonly connections: ConnectionManager;
  readonly log: DeploymentLog;
  readonly showLog: () => void;
  readonly documents: RemoteDocuments;
}

/** The address of a deployed version in an editor tab, if the tab shows one. */
function remoteUris(tab: vscode.Tab): vscode.Uri[] {
  const { input } = tab;
  const uris =
    input instanceof vscode.TabInputTextDiff
      ? [input.original, input.modified]
      : input instanceof vscode.TabInputText
        ? [input.uri]
        : [];
  return uris.filter((uri) => uri.scheme === REMOTE_SCHEME);
}

/**
 * Compares local files with their deployed versions and keeps those versions in memory while
 * an editor tab shows them.
 */
export class DeployedVersionCompare implements vscode.Disposable {
  private readonly options: CompareOptions;
  private readonly tabEvents: vscode.Disposable;

  constructor(options: CompareOptions) {
    this.options = options;
    this.tabEvents = vscode.window.tabGroups.onDidChangeTabs((event) => {
      this.forgetClosed(event.closed);
    });
  }

  /**
   * Compares `localFile` with its deployed version on the server of `choice` and opens the
   * diff. The file must be in the workspace folder the server is configured for. Every
   * outcome other than `opened` has been shown to the user already.
   */
  async compareFile(choice: SftpServerChoice, localFile: vscode.Uri): Promise<CompareResult> {
    const fileName = notificationText(basename(localFile.fsPath), 200);
    const folder =
      localFile.scheme === 'file' ? vscode.workspace.getWorkspaceFolder(localFile) : undefined;
    if (folder === undefined || !choice.key.startsWith(connectionKey(folder.uri.toString(), ''))) {
      void vscode.window.showWarningMessage(
        `${fileName} is not inside the project folder ${notificationText(choice.folderName, 100)}.`,
      );
      return { outcome: 'outside' };
    }
    let projectDir: string;
    let canonical: string;
    try {
      projectDir = await realpath(folder.uri.fsPath);
      canonical = await realpath(localFile.fsPath);
      if (!(await stat(canonical)).isFile()) {
        void vscode.window.showWarningMessage(
          `${fileName} is not a file. Select a file to compare.`,
        );
        return { outcome: 'localNotFile' };
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'EACCES' && code !== 'ELOOP') {
        throw error;
      }
      void vscode.window.showWarningMessage(
        `${fileName} could not be read from the disk (${code}).`,
      );
      return { outcome: 'localNotFile' };
    }
    return runCompare(this.host(localFile), {
      choice,
      projectDir,
      localFile: canonical,
      // The name the user chose: a symbolic link in the project keeps its own name.
      displayName: basename(localFile.fsPath),
      platform: process.platform,
    });
  }

  private host(localFile: vscode.Uri): CompareHost {
    const { connections, log, showLog, documents } = this.options;
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
        void vscode.window.showInformationMessage(message);
      },
      showWarning: (message) => {
        void vscode.window.showWarningMessage(message);
      },
      showError: (message) => {
        withShowLog(vscode.window.showErrorMessage(message, 'Show Log'));
      },
      openDiff: async (document: OpenedDocument, title: string) => {
        const address = documents.add(document.path, document.content, document.mtimeMs);
        const remote = vscode.Uri.from({
          scheme: REMOTE_SCHEME,
          path: address.path,
          query: address.query,
        });
        await vscode.commands.executeCommand('vscode.diff', remote, localFile, title);
      },
    };
  }

  /** Drops the deployed versions no open tab shows any more. */
  private forgetClosed(closed: readonly vscode.Tab[]): void {
    const candidates = closed.flatMap(remoteUris);
    if (candidates.length === 0) {
      return;
    }
    const open = new Set(
      vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .flatMap(remoteUris)
        .map((uri) => uri.toString()),
    );
    for (const uri of candidates) {
      if (!open.has(uri.toString())) {
        this.options.documents.remove(uri);
      }
    }
  }

  dispose(): void {
    this.tabEvents.dispose();
  }
}

/** What the command did: a comparison, or why none was made (the user was told). */
export type CompareCommandResult =
  | CompareResult
  | {
      readonly outcome:
        | 'noFile'
        | 'notOnDisk'
        | 'noWorkspaceFolder'
        | 'inPlaceOnly'
        | 'noServer'
        | 'noMapping'
        | 'notChosen';
    };

export interface CompareCommandOptions {
  readonly compare: DeployedVersionCompare;
  /** Loads the configurations of the workspace folders from disk (fresh for every command). */
  readonly loadFolders: () => Promise<FoldersSnapshot>;
  readonly openConfigCommand: string;
  /** Return the result to the caller (extension tests only). */
  readonly returnResults: boolean;
}

/**
 * The command. Its argument is the file of the Explorer, editor or tab context menu; without
 * one (Command Palette, key binding) it compares the file of the active editor.
 */
export function registerCompareCommand(options: CompareCommandOptions): vscode.Disposable {
  const compare = async (argument?: unknown): Promise<CompareCommandResult> => {
    const file =
      argument instanceof vscode.Uri ? argument : vscode.window.activeTextEditor?.document.uri;
    if (file === undefined) {
      void vscode.window.showInformationMessage(
        'Open or select a file to compare with its deployed version.',
      );
      return { outcome: 'noFile' };
    }
    const fileName = notificationText(basename(file.path), 200);
    if (file.scheme !== 'file') {
      void vscode.window.showWarningMessage(
        `${COMMAND_TITLE} works with files saved on the disk only.`,
      );
      return { outcome: 'notOnDisk' };
    }
    const folder = vscode.workspace.getWorkspaceFolder(file);
    if (folder === undefined) {
      void vscode.window.showWarningMessage(`${fileName} is not in a workspace folder.`);
      return { outcome: 'noWorkspaceFolder' };
    }
    const folderKey = folder.uri.toString();
    const snapshot = await options.loadFolders();
    const choices = choicesOfFolder(configuredSftpServers(snapshot), folderKey);
    if (choices.length === 0) {
      const status = snapshot.statuses.find((candidate) => candidate.folder.key === folderKey);
      const servers = status?.result.status === 'ok' ? status.result.config.servers : [];
      if (servers.some((server) => server.type === 'inplace')) {
        void vscode.window.showInformationMessage(
          'In-place servers run from the project folder itself, so there is no deployed ' +
            'version to compare with.',
        );
        return { outcome: 'inPlaceOnly' };
      }
      const open = 'Open Config';
      const answer = await vscode.window.showErrorMessage(
        `No SFTP server is configured for ${notificationText(folder.name, 100)}.`,
        open,
      );
      if (answer === open) {
        await vscode.commands.executeCommand(options.openConfigCommand);
      }
      return { outcome: 'noServer' };
    }
    const choice = await chooseDeploymentServer(choices, COMMAND_TITLE);
    if (choice === null) {
      void vscode.window.showWarningMessage(
        `No SFTP server of ${notificationText(folder.name, 100)} has a mapping. ` +
          'Add one in Deployment: Open Settings.',
      );
      return { outcome: 'noMapping' };
    }
    if (choice === undefined) {
      return { outcome: 'notChosen' };
    }
    return options.compare.compareFile(choice, file);
  };
  return vscode.commands.registerCommand(
    COMPARE_COMMAND,
    async (argument?: unknown): Promise<CompareCommandResult | undefined> => {
      const result = await compare(argument);
      return options.returnResults ? result : undefined;
    },
  );
}
