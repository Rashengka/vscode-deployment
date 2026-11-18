/** The connection item in the status bar: `$(plug) <server>` or disconnected; click = menu. */
import * as vscode from 'vscode';
import { ConnectionStates, statusBarPresentation } from './connectionPresentation';

export const CONTEXT_CONNECTED = 'vscodeDeployment.connected';
export const SHOW_CONNECTION_MENU_COMMAND = 'vscodeDeployment.showConnectionMenu';

export class ConnectionStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly states: ConnectionStates;
  private configured = false;
  private connected: boolean | undefined;

  constructor(states: ConnectionStates) {
    this.states = states;
    this.item = vscode.window.createStatusBarItem(
      'vscodeDeployment.connection',
      vscode.StatusBarAlignment.Left,
      0,
    );
    this.item.name = 'Deployment Connection';
    this.item.command = SHOW_CONNECTION_MENU_COMMAND;
    this.update();
  }

  /** Shown while a workspace folder has a configuration or a connection is open. */
  setConfigured(configured: boolean): void {
    this.configured = configured;
    this.update();
  }

  update(): void {
    const presentation = statusBarPresentation(this.states);
    this.item.text = presentation.text;
    this.item.tooltip = presentation.tooltip;
    const active = this.states.anyActive();
    if (this.configured || active) {
      this.item.show();
    } else {
      this.item.hide();
    }
    if (this.connected !== active) {
      this.connected = active;
      void vscode.commands.executeCommand('setContext', CONTEXT_CONNECTED, active);
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
