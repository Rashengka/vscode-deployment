import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { extensionUnderTest } from './extensionUnderTest';

const HELLO_WORLD_COMMAND = 'vscodeDeployment.helloWorld';

describe('hello world command', () => {
  it('is contributed and registered', async () => {
    const extension = extensionUnderTest();
    await extension.activate();

    assert.equal(extension.isActive, true);
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes(HELLO_WORLD_COMMAND), `${HELLO_WORLD_COMMAND} is not registered`);
  });

  it('runs and returns its message', async () => {
    const result = await vscode.commands.executeCommand<string>(HELLO_WORLD_COMMAND);
    assert.equal(result, 'Hello from Deployment.');
  });
});
