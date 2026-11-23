import { describe, expect, it } from 'vitest';
import {
  diffTitle,
  runCompare,
  type CompareHost,
  type CompareRequest,
  type OpenedDocument,
} from '../../../src/compare/compareFlow';
import { DeploymentLog, type LogSink } from '../../../src/log/deploymentLog';
import { ConnectionError, type ConnectionStatus } from '../../../src/ssh/connectionManager';
import {
  RemoteFileTooLargeError,
  RemoteReadCancelledError,
  RemoteReadError,
  type DeploymentTarget,
  type RemoteStat,
} from '../../../src/transport/deploymentTarget';
import { connectionKey, type SftpServerChoice } from '../../../src/ui/serverChoices';
import { sftpServer } from '../../support/connectionFixture';

const LINK = '[x](command:workbench.action.terminal.sendSequence?%7B%7D)';

function choiceOf(name = 'Production'): SftpServerChoice {
  return {
    key: connectionKey('file:///var/www/app', 'a'),
    server: sftpServer('a', 'prod', {
      name,
      mappings: [{ localPath: '.', deploymentPath: 'www/app' }],
      excludedLocalPaths: ['var'],
    }),
    folderName: 'app',
    configFile: '/home/deploy/.config/vscode-deployment/projects/-var-www-app/config.json',
  };
}

function request(localFile: string, choice = choiceOf(), displayName?: string): CompareRequest {
  return {
    choice,
    projectDir: '/var/www/app',
    localFile,
    displayName: displayName ?? localFile.slice(localFile.lastIndexOf('/') + 1),
    platform: 'linux',
  };
}

const file: RemoteStat = { type: 'file', size: 5, mtime: 1_700_000_000, mode: 0o644 };

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
  readonly host: CompareHost;
  readonly messages: string[];
  readonly opened: { document: OpenedDocument; title: string }[];
  readonly lstats: string[];
  readonly disconnected: string[];
  readonly log: Recorder;
  cancel(): void;
}

function fake(
  target: Partial<Pick<DeploymentTarget, 'lstat' | 'readFile'>>,
  options: { status?: ConnectionStatus } = {},
): Fake {
  const messages: string[] = [];
  const opened: Fake['opened'] = [];
  const lstats: string[] = [];
  const disconnected: string[] = [];
  const log = new Recorder();
  let cancelListener: (() => void) | undefined;
  const full: Pick<DeploymentTarget, 'lstat' | 'readFile'> = {
    lstat: (path) => {
      lstats.push(path);
      return target.lstat?.(path) ?? Promise.resolve(file);
    },
    readFile: (path, maxBytes, signal) =>
      target.readFile?.(path, maxBytes, signal) ?? Promise.resolve(Buffer.from('hello')),
  };
  const host: CompareHost = {
    connections: {
      status: () => options.status ?? 'disconnected',
      run: ((_reference: unknown, operation: (t: DeploymentTarget) => Promise<unknown>) =>
        operation(full as DeploymentTarget)) as CompareHost['connections']['run'],
      disconnect: (key) => {
        disconnected.push(key);
      },
    },
    log: new DeploymentLog(log),
    withProgress: (_title, work) =>
      work((listener) => {
        cancelListener = listener;
      }),
    showInformation: (message) => messages.push(`info: ${message}`),
    showWarning: (message) => messages.push(`warning: ${message}`),
    showError: (message) => messages.push(`error: ${message}`),
    openDiff: (document, title) => {
      opened.push({ document, title });
      return Promise.resolve();
    },
  };
  return {
    host,
    messages,
    opened,
    lstats,
    disconnected,
    log,
    cancel: () => {
      cancelListener?.();
    },
  };
}

describe('diffTitle', () => {
  it('names the file and the server, with invisible characters made visible', () => {
    expect(diffTitle('index.php', 'Production')).toBe('index.php (Production) ↔ Local');
    expect(diffTitle('a‮txt.exe', 'P\nrod')).toBe('a\\u202etxt.exe (P\\nrod) ↔ Local');
  });
});

describe('runCompare', () => {
  it('opens the diff of the deployed version and the local file', async () => {
    const f = fake({});
    const result = await runCompare(f.host, request('/var/www/app/src/index.php'));
    expect(result).toEqual({
      outcome: 'opened',
      title: 'index.php (Production) ↔ Local',
      remotePath: '/home/deploy/www/app/src/index.php',
    });
    expect(f.opened).toHaveLength(1);
    expect(f.opened[0]?.title).toBe('index.php (Production) ↔ Local');
    expect(f.opened[0]?.document).toEqual({
      path: '/home/deploy/www/app/src/index.php',
      content: Buffer.from('hello'),
      mtimeMs: 1_700_000_000_000,
    });
    expect(f.messages).toEqual([]);
  });

  it('says that the file does not exist on the server', async () => {
    const f = fake({ lstat: () => Promise.resolve(null) });
    const result = await runCompare(f.host, request('/var/www/app/a.php'));
    expect(result.outcome).toBe('missing');
    expect(f.messages).toEqual(['warning: File does not exist on Production']);
    expect(f.opened).toHaveLength(0);
  });

  it('refuses a symbolic link, a folder, a binary file and a file over the limit', async () => {
    const cases: [Partial<Pick<DeploymentTarget, 'lstat' | 'readFile'>>, string, string][] = [
      [
        { lstat: () => Promise.resolve({ ...file, type: 'symlink' }) },
        'symlink',
        'warning: a.php on Production is a symbolic link. Compare with Deployed Version does not follow links on the server.',
      ],
      [
        { lstat: () => Promise.resolve({ ...file, type: 'directory' }) },
        'notFile',
        'warning: a.php on Production is not a regular file.',
      ],
      [
        { readFile: () => Promise.resolve(Buffer.from([0, 1, 2])) },
        'binary',
        'info: a.php on Production is a binary file. Compare with Deployed Version shows text files only.',
      ],
      [
        { readFile: () => Promise.reject(new RemoteFileTooLargeError(20 * 1024 * 1024)) },
        'tooLarge',
        'warning: a.php on Production is larger than 20 MB. Compare with Deployed Version compares files up to 20 MB.',
      ],
    ];
    for (const [target, outcome, message] of cases) {
      const f = fake(target);
      const result = await runCompare(f.host, request('/var/www/app/a.php'));
      expect(result.outcome).toBe(outcome);
      expect(f.messages).toEqual([message]);
      expect(f.opened).toHaveLength(0);
    }
  });

  it('downloads nothing for a file outside the project, outside every mapping or excluded', async () => {
    const narrow = choiceOf();
    const unmapped: SftpServerChoice = {
      ...narrow,
      server: { ...narrow.server, mappings: [{ localPath: 'src', deploymentPath: 'www' }] },
    };
    const cases: [CompareRequest, string, string][] = [
      [
        request('/var/www/other/a.php'),
        'outside',
        'warning: a.php is not inside the project folder app.',
      ],
      [
        request('/var/www/app/a.php', unmapped),
        'unmapped',
        'warning: a.php is not in any mapping of Production.',
      ],
      [
        request('/var/www/app/var/a.php'),
        'excluded',
        'warning: a.php is excluded from deployment to Production.',
      ],
    ];
    for (const [req, outcome, message] of cases) {
      const f = fake({});
      const result = await runCompare(f.host, req);
      expect(result.outcome).toBe(outcome);
      expect(f.messages).toEqual([message]);
      expect(f.lstats).toEqual([]);
    }
  });

  it('reports a connection failure without links from the server', async () => {
    const f = fake({ lstat: () => Promise.reject(new ConnectionError(`gone ${LINK}`)) });
    const result = await runCompare(f.host, request('/var/www/app/a.php'));
    expect(result.outcome).toBe('failed');
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0]).toMatch(/^error: Compare with Deployed Version of a\.php failed: gone /);
    expect(f.messages[0]).not.toContain('](');
  });

  it('reports an SFTP error of the server, for example a refused read', async () => {
    const denied = Object.assign(new Error('Permission denied'), { code: 3 });
    const f = fake({ readFile: () => Promise.reject(denied) });
    const result = await runCompare(f.host, request('/var/www/app/a.php'));
    expect(result.outcome).toBe('failed');
    expect(f.messages).toEqual([
      'error: Compare with Deployed Version of a.php failed: The server reported an SFTP error: Permission denied',
    ]);
  });

  it('does not show the message of an unexpected error, only logs it', async () => {
    const f = fake({ lstat: () => Promise.reject(new TypeError('secret detail')) });
    const result = await runCompare(f.host, request('/var/www/app/a.php'));
    expect(result.outcome).toBe('failed');
    expect(f.messages.join('\n')).not.toContain('secret detail');
    expect(f.log.lines.join('\n')).toContain('secret detail');
  });

  it('stops reading when cancelled and closes only a connection it opened', async () => {
    let signalSeen: AbortSignal | undefined;
    const f = fake({
      readFile: (_path, _max, signal) => {
        signalSeen = signal;
        f.cancel();
        return Promise.reject(new RemoteReadCancelledError());
      },
    });
    const result = await runCompare(f.host, request('/var/www/app/a.php'));
    expect(result.outcome).toBe('cancelled');
    expect(signalSeen?.aborted).toBe(true);
    expect(f.messages).toEqual([]);
    expect(f.opened).toHaveLength(0);
    expect(f.disconnected).toEqual([choiceOf().key]);
  });

  it('keeps a connection that was open before when cancelled', async () => {
    const f = fake(
      {
        readFile: () => {
          f.cancel();
          return Promise.reject(new RemoteReadCancelledError());
        },
      },
      { status: 'connected' },
    );
    const result = await runCompare(f.host, request('/var/www/app/a.php'));
    expect(result.outcome).toBe('cancelled');
    expect(f.disconnected).toEqual([]);
  });

  it('names the file the user chose, while mapping its canonical path', async () => {
    const f = fake({ readFile: () => Promise.resolve(Buffer.from([0])) });
    const linked = request('/var/www/app/src/real.php', choiceOf(), 'link.php');
    const binary = await runCompare(f.host, linked);
    expect(binary).toEqual({ outcome: 'binary', remotePath: '/home/deploy/www/app/src/real.php' });
    expect(f.messages).toEqual([
      'info: link.php on Production is a binary file. Compare with Deployed Version shows text files only.',
    ]);

    const text = fake({});
    const opened = await runCompare(text.host, linked);
    expect(opened.title).toBe('link.php (Production) ↔ Local');
    expect(opened.remotePath).toBe('/home/deploy/www/app/src/real.php');
  });

  it('downloads nothing when the path on the server would leave the root path', async () => {
    const base = choiceOf();
    const escaping: SftpServerChoice = {
      ...base,
      server: { ...base.server, mappings: [{ localPath: '.', deploymentPath: '../../etc' }] },
    };
    const f = fake({});
    const result = await runCompare(f.host, request('/var/www/app/passwd', escaping));
    expect(result).toEqual({ outcome: 'outside' });
    expect(f.messages).toEqual([
      'warning: passwd would be outside the root path of Production on the server.',
    ]);
    expect(f.lstats).toEqual([]);
  });

  it('reports a server that sends the file in too many pieces as a failure', async () => {
    const f = fake({
      readFile: () =>
        Promise.reject(new RemoteReadError('The server sent the file in too many small pieces.')),
    });
    const result = await runCompare(f.host, request('/var/www/app/a.php'));
    expect(result.outcome).toBe('failed');
    expect(f.messages).toEqual([
      'error: Compare with Deployed Version of a.php failed: The server sent the file in too many small pieces.',
    ]);
  });
});
