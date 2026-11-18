import { describe, expect, it } from 'vitest';
import { DeploymentLog, type LogSink } from '../../../src/log/deploymentLog';
import {
  ConnectionError,
  type ConnectionDetails,
  type ConnectionStatus,
} from '../../../src/ssh/connectionManager';
import type { DeploymentTarget } from '../../../src/transport/deploymentTarget';
import { connectionKey, type SftpServerChoice } from '../../../src/ui/serverChoices';
import { runTestConnection, type TestConnectionHost } from '../../../src/ui/testConnectionFlow';
import { sftpServer } from '../../support/connectionFixture';

const LINK = '[x](command:workbench.action.terminal.sendSequence?%7B%7D)';

const choice: SftpServerChoice = {
  key: connectionKey('file:///var/www/app', 'a'),
  server: sftpServer('a', 'prod', { name: 'Production' }),
  folderName: 'app',
  configFile: '/home/deploy/.config/vscode-deployment/projects/-var-www-app/config.json',
};

class Recorder implements LogSink {
  readonly lines: string[] = [];
  info(message: string): void {
    this.lines.push(message);
  }
  warn(message: string): void {
    this.lines.push(message);
  }
  error(message: string): void {
    this.lines.push(message);
  }
}

interface Fake {
  readonly host: TestConnectionHost;
  readonly information: string[];
  readonly errors: string[];
  readonly disconnected: string[];
  readonly log: Recorder;
  cancel(): void;
}

function fake(options: {
  status?: ConnectionStatus;
  realpath: () => Promise<string>;
  details?: ConnectionDetails;
}): Fake {
  const information: string[] = [];
  const errors: string[] = [];
  const disconnected: string[] = [];
  const log = new Recorder();
  let cancelListener: (() => void) | undefined;
  const target = { realpath: options.realpath } as unknown as DeploymentTarget;
  const host: TestConnectionHost = {
    connections: {
      status: () => options.status ?? 'disconnected',
      run: ((_reference: unknown, operation: (target: DeploymentTarget) => Promise<unknown>) =>
        operation(target)) as TestConnectionHost['connections']['run'],
      disconnect: (key) => {
        disconnected.push(key);
      },
      details: () => options.details,
    },
    log: new DeploymentLog(log),
    withProgress: (_title, work) =>
      work((listener) => {
        cancelListener = listener;
      }),
    showInformation: (message) => information.push(message),
    showError: (message) => errors.push(message),
  };
  return {
    host,
    information,
    errors,
    disconnected,
    log,
    cancel: () => {
      cancelListener?.();
    },
  };
}

const never = (): Promise<string> => new Promise(() => undefined);

describe('runTestConnection', () => {
  it('reports the user and home directory without any link syntax from the server', async () => {
    const test = fake({
      realpath: () => Promise.resolve(`/var/www/${LINK}`),
      details: { user: 'deploy', description: 'deploy@example.com:22', banner: `Hi ${LINK}` },
    });

    const result = await runTestConnection(test.host, choice);

    expect(result?.user).toBe('deploy');
    expect(test.information).toHaveLength(1);
    expect(test.information[0]).not.toMatch(/\]\(/);
    expect(test.information[0]).toContain('Connected to Production as deploy.');
    expect(test.information[0]).not.toContain('Hi ');
    expect(test.log.lines.join('\n')).toContain('home directory /var/www/[x](command:');
  });

  it('shows a connection error without link syntax', async () => {
    const test = fake({
      realpath: () => Promise.reject(new ConnectionError(`Disconnected by server: ${LINK}`)),
    });

    await expect(runTestConnection(test.host, choice)).resolves.toBeUndefined();

    expect(test.errors).toHaveLength(1);
    expect(test.errors[0]).toContain('Test Connection to Production failed: Disconnected by');
    expect(test.errors[0]).not.toMatch(/\]\(/);
  });

  it('shows a general message for an unexpected error and logs the details', async () => {
    const test = fake({ realpath: () => Promise.reject(new TypeError(`bug ${LINK}`)) });

    await expect(runTestConnection(test.host, choice)).resolves.toBeUndefined();

    expect(test.errors).toEqual([
      'Test Connection to Production failed because of an unexpected error. ' +
        'The details are in the Deployment log.',
    ]);
    expect(test.log.lines.join('\n')).toContain('Test Connection (unexpected error): bug [x](');
  });

  it('ends quietly when cancelled while waiting, and closes the attempt it opened', async () => {
    const test = fake({ realpath: never });

    const running = runTestConnection(test.host, choice);
    test.cancel();

    await expect(running).resolves.toBeUndefined();
    expect(test.errors).toEqual([]);
    expect(test.disconnected).toEqual([choice.key]);
  });

  it('does not close a connection that was open before', async () => {
    const test = fake({ status: 'connected', realpath: never });

    const running = runTestConnection(test.host, choice);
    test.cancel();

    await expect(running).resolves.toBeUndefined();
    expect(test.disconnected).toEqual([]);
    expect(test.errors).toEqual([]);
  });

  it('stays quiet when the cancelled attempt then fails with any error', async () => {
    let fail: (error: Error) => void = () => undefined;
    const test = fake({
      realpath: () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    });

    const running = runTestConnection(test.host, choice);
    test.cancel();
    fail(new TypeError('after cancel'));

    await expect(running).resolves.toBeUndefined();
    expect(test.errors).toEqual([]);
  });

  it('explains an SFTP session that ends between login and the home directory', async () => {
    const test = fake({
      realpath: () =>
        Promise.reject(new ConnectionError('The SFTP session to Production ended: No response')),
    });

    await runTestConnection(test.host, choice);

    expect(test.errors).toEqual([
      'Test Connection to Production failed: The SFTP session to Production ended: No response',
    ]);
  });
});
