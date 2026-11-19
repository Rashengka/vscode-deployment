import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { extensionUnderTest } from './extensionUnderTest';

interface ContributedCommand {
  readonly command: string;
}

describe('activation', () => {
  it('activates and registers every contributed command', async () => {
    const extension = extensionUnderTest();
    await extension.activate();
    assert.equal(extension.isActive, true);

    const packageJson = extension.packageJSON as {
      contributes: { commands: readonly ContributedCommand[] };
    };
    const contributed = packageJson.contributes.commands.map((entry) => entry.command);
    assert.ok(contributed.length > 0, 'no command is contributed');
    const registered = await vscode.commands.getCommands(true);
    for (const command of contributed) {
      assert.ok(registered.includes(command), `${command} is not registered`);
    }
  });
});
