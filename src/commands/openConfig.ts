import * as vscode from 'vscode';
import { UnownedConfigError, UnsafeConfigError, ensureConfigFile } from '../config/store';
import type { StoreOptions } from '../config/store';

export const OPEN_CONFIG_COMMAND = 'vscodeDeployment.openConfig';

async function pickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter(
    (folder) => folder.uri.scheme === 'file',
  );
  if (folders.length <= 1) {
    return folders[0];
  }
  return vscode.window.showWorkspaceFolderPick({
    placeHolder: 'Select the folder whose deployment configuration to open',
  });
}

/**
 * Opens `config.json` of a workspace folder in an editor, creating an empty valid configuration
 * first when there is none. Returns the URI of the opened file, or `undefined` when nothing was
 * opened.
 */
export async function openConfig(
  storeOptions: () => StoreOptions,
): Promise<vscode.Uri | undefined> {
  const folder = await pickFolder();
  if (folder === undefined) {
    if ((vscode.workspace.workspaceFolders ?? []).length === 0) {
      void vscode.window.showErrorMessage('Open a folder to configure deployment for it.');
    }
    return undefined;
  }
  let file: string;
  try {
    ({ file } = await ensureConfigFile(folder.uri.fsPath, storeOptions()));
  } catch (error) {
    if (error instanceof UnsafeConfigError || error instanceof UnownedConfigError) {
      void vscode.window.showErrorMessage(error.message);
      return undefined;
    }
    throw error;
  }
  const uri = vscode.Uri.file(file);
  await vscode.window.showTextDocument(uri);
  return uri;
}
