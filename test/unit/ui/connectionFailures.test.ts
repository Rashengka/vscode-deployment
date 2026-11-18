import { describe, expect, it } from 'vitest';
import { ConnectionError } from '../../../src/ssh/connectionManager';
import { PassphraseCancelledError } from '../../../src/ssh/passphrase';
import { WrongPassphraseError } from '../../../src/ssh/privateKey';
import { connectionFailure } from '../../../src/ui/connectionFailures';

describe('connectionFailure', () => {
  it('treats a cancelled passphrase prompt as cancelled, not as a failure', () => {
    expect(connectionFailure(new PassphraseCancelledError('/home/deploy/.ssh/id_ed25519'))).toEqual(
      { kind: 'cancelled' },
    );
  });

  it('passes the message of the expected connection errors on', () => {
    expect(connectionFailure(new ConnectionError('Cannot connect.'))).toEqual({
      kind: 'failed',
      message: 'Cannot connect.',
    });
    expect(connectionFailure(new WrongPassphraseError('/home/deploy/.ssh/id_ed25519'))).toEqual({
      kind: 'failed',
      message: 'The passphrase for /home/deploy/.ssh/id_ed25519 is not correct.',
    });
  });

  it('recognizes SFTP status errors by their numeric code', () => {
    const error = Object.assign(new Error('Permission denied'), { code: 3 });

    expect(connectionFailure(error)).toEqual({
      kind: 'failed',
      message: 'The server reported an SFTP error: Permission denied',
    });
  });

  it('does not catch unexpected errors', () => {
    expect(connectionFailure(new TypeError('x is undefined'))).toBeUndefined();
    expect(
      connectionFailure(Object.assign(new Error('EACCES'), { code: 'EACCES' })),
    ).toBeUndefined();
    expect(connectionFailure('text')).toBeUndefined();
  });
});
