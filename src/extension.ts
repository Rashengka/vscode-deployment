import * as vscode from 'vscode';

export const HELLO_WORLD_COMMAND = 'vscodeDeployment.helloWorld';
export const HELLO_WORLD_MESSAGE = 'Hello from Deployment.';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(HELLO_WORLD_COMMAND, () => {
      void vscode.window.showInformationMessage(HELLO_WORLD_MESSAGE);
      return HELLO_WORLD_MESSAGE;
    }),
  );
}

export function deactivate(): void {
  // Nothing to release yet; disposables are owned by the extension context.
}
