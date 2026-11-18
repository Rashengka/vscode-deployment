import * as vscode from 'vscode';
import type { SettingsPanelHandle, SettingsPanels } from '../webview/settingsPanel';
import { pickFolder } from './openConfig';

/**
 * Opens the settings panel of a workspace folder (asking which one in a multi-root workspace).
 * Returns the panel only when `exposeHandle` is set (extension tests), else `undefined`.
 */
export async function openSettings(
  panels: SettingsPanels,
  exposeHandle: boolean,
): Promise<SettingsPanelHandle | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showErrorMessage('Open a folder to configure deployment for it.');
    return undefined;
  }
  if (!folders.some((folder) => folder.uri.scheme === 'file')) {
    void vscode.window.showErrorMessage(
      'Deployment settings are available for folders on the local file system only.',
    );
    return undefined;
  }
  const folder = await pickFolder('Select the folder whose deployment settings to open');
  if (folder === undefined) {
    return undefined;
  }
  const handle = panels.open(folder);
  return exposeHandle ? handle : undefined;
}
