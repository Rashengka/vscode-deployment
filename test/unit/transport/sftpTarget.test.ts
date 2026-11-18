import type { SFTPWrapper } from 'ssh2';
import { describe, expect, it } from 'vitest';
import { ConnectionError } from '../../../src/ssh/connectionManager';
import { SftpTarget } from '../../../src/transport/sftpTarget';

type Callback = (error: Error | undefined, value?: unknown) => void;

/** An SFTP session whose every request fails with `error`. */
function failingSftp(error: Error): SFTPWrapper {
  const fail = (_path: string, callback: Callback): void => {
    callback(error);
  };
  return { realpath: fail, stat: fail } as unknown as SFTPWrapper;
}

describe('SftpTarget', () => {
  it('reports a closed SFTP channel as a connection error', async () => {
    const target = new SftpTarget(failingSftp(new Error('No response from server')), 'Prod');

    const failure = target.realpath('.').then(
      () => undefined,
      (error: unknown) => error,
    );

    const error = await failure;
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as Error).message).toBe(
      'The SFTP session to Prod ended: No response from server',
    );
    await expect(target.stat('/var/www/app')).rejects.toBeInstanceOf(ConnectionError);
  });

  it('keeps SFTP status errors of the server as they are', async () => {
    const status = Object.assign(new Error('Permission denied'), { code: 3 });
    const target = new SftpTarget(failingSftp(status), 'Prod');

    await expect(target.realpath('.')).rejects.toBe(status);
  });

  it('reports a missing file as null in stat', async () => {
    const missing = Object.assign(new Error('No such file'), { code: 2 });
    const target = new SftpTarget(failingSftp(missing), 'Prod');

    await expect(target.stat('/var/www/app/x')).resolves.toBeNull();
  });
});
