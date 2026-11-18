import { describe, expect, it } from 'vitest';
import { DeploymentLog, redactKeyMaterial, type LogSink } from '../../../src/log/deploymentLog';

class RecordingSink implements LogSink {
  readonly lines: string[] = [];
  info(message: string): void {
    this.lines.push(`info ${message}`);
  }
  warn(message: string): void {
    this.lines.push(`warn ${message}`);
  }
  error(message: string): void {
    this.lines.push(`error ${message}`);
  }
}

// Shapes of key files, built at run time so that no key-like block is stored in the repository.
const BEGIN = ['-----BEGIN', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ');
const END = ['-----END', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ');
const OPENSSH_BODY = Buffer.from('openssh-key-v1\u0000not a real key').toString('base64');

describe('DeploymentLog', () => {
  it('writes the server and the action', () => {
    const sink = new RecordingSink();
    const log = new DeploymentLog(sink);

    log.info('Production', 'Test Connection', 'connected as deploy');
    log.info(undefined, 'Disconnect All');

    expect(sink.lines).toEqual([
      'info [Production] Test Connection: connected as deploy',
      'info Disconnect All',
    ]);
  });

  it('keeps every entry on one line, so that a server cannot forge entries', () => {
    const sink = new RecordingSink();
    const log = new DeploymentLog(sink);

    log.info('Prod\nuction', 'Banner', 'Welcome\n[Other] Upload: done\u001b[2K\u202e');

    expect(sink.lines).toEqual([
      'info [Prod\\nuction] Banner: Welcome\\n[Other] Upload: done\\x1b[2K\\u202e',
    ]);
  });

  it('writes the sanitized message of an error, not the error object', () => {
    const sink = new RecordingSink();
    const log = new DeploymentLog(sink);
    const error = new Error('Cannot connect\u0007');

    log.error('Production', 'Test Connection', error);
    log.error('Production', 'Test Connection', { secret: 'object' });

    expect(sink.lines).toEqual([
      'error [Production] Test Connection: Cannot connect\\x07',
      'error [Production] Test Connection: Unknown error.',
    ]);
  });

  it('removes key material from error messages too', () => {
    const sink = new RecordingSink();
    const log = new DeploymentLog(sink);
    const body = `${OPENSSH_BODY}\n${OPENSSH_BODY.replace('b3BlbnNzaC1rZXktdjE', 'QUJD')}`;

    log.error('Production', 'Connect', new Error(`Bad key ${body}`));

    expect(sink.lines).toEqual(['error [Production] Connect: Bad key [private key removed]']);
  });

  it('never writes key material', () => {
    const sink = new RecordingSink();
    const log = new DeploymentLog(sink);

    log.warn('Production', 'Key', `${BEGIN}\n${OPENSSH_BODY}\n${END}`);

    expect(sink.lines.join('\n')).not.toContain(OPENSSH_BODY);
    expect(sink.lines).toEqual(['warn [Production] Key: [private key removed]']);
  });
});

describe('redactKeyMaterial', () => {
  it('removes complete and cut-off private key blocks of any kind', () => {
    const rsaBegin = BEGIN.replace('OPENSSH', 'RSA');
    const rsaEnd = END.replace('OPENSSH', 'RSA');

    expect(redactKeyMaterial(`a ${rsaBegin}\nAAAA\n${rsaEnd} b`)).toBe('a [private key removed] b');
    expect(redactKeyMaterial(`a ${BEGIN}\nAAAA`)).toBe('a [private key removed]');
  });

  it('removes OpenSSH key data and PuTTY key files without the armor', () => {
    expect(redactKeyMaterial(`x ${OPENSSH_BODY} y`)).toBe('x [private key removed] y');
    expect(redactKeyMaterial('PuTTY-User-Key-File-2: ssh-rsa\nEncryption: none')).toBe(
      '[private key removed]',
    );
  });

  it('removes SSH2 (RFC 4716) private key blocks', () => {
    const begin = ['----', 'BEGIN', 'SSH2', 'ENCRYPTED', 'PRIVATE', 'KEY', '----'].join(' ');
    const end = ['----', 'END', 'SSH2', 'ENCRYPTED', 'PRIVATE', 'KEY', '----'].join(' ');

    expect(redactKeyMaterial(`a ${begin}\nComment: x\nAAAA\n${end} b`)).toBe(
      'a [private key removed] b',
    );
    expect(redactKeyMaterial(`a ${begin}\nAAAA`)).toBe('a [private key removed]');
  });

  it('treats a lone carriage return as a line break in OpenSSH key data', () => {
    const second = OPENSSH_BODY.replace('b3BlbnNzaC1rZXktdjE', 'QUJD');

    expect(redactKeyMaterial(`x ${OPENSSH_BODY}\r${second} y`)).toBe('x [private key removed] y');
  });

  it('keeps ordinary text', () => {
    expect(redactKeyMaterial('Connected to deploy@example.com:22')).toBe(
      'Connected to deploy@example.com:22',
    );
  });
});
