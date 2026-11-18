import { describe, expect, it } from 'vitest';
import { MochaOutputFilter } from '../../scripts/lib/extensionTestOutput.mts';

function filter(lines: readonly string[]): string[] {
  const output = new MochaOutputFilter();
  return lines.flatMap((line) => {
    const kept = output.accept(line);
    return kept === undefined ? [] : [kept];
  });
}

describe('MochaOutputFilter', () => {
  it('keeps the results of mocha and the exit code of VS Code', () => {
    expect(
      filter([
        '    ✔ is contributed and registered',
        '    ✔ connects with a passphrase-protected key and opens SFTP (219ms)',
        '    1) rejects a host that is not in known_hosts',
        '  16 passing (4s)',
        '  1 pending',
        '  2 failing',
        'Exit code:   0',
        'Exit code:   SIGTERM',
      ]),
    ).toEqual([
      '    ✔ is contributed and registered',
      '    ✔ connects with a passphrase-protected key and opens SFTP (219ms)',
      '    1) rejects a host that is not in known_hosts',
      '  16 passing (4s)',
      '  1 pending',
      '  2 failing',
      'Exit code:   0',
      'Exit code:   SIGTERM',
    ]);
  });

  it('keeps the shape of failure reports after "failing"', () => {
    expect(
      filter([
        '  1 failing',
        '',
        '  1) secret leak canary',
        '       "before all" hook for "(a) logs in":',
        '     Error: spawn docker ENOENT',
        '      AssertionError [ERR_ASSERTION]: the logs have no lines',
        '      + expected - actual',
        '      -false',
        '      +true',
        '      at Context.<anonymous> (out/test/extension/x.test.js:12:3)',
      ]),
    ).toEqual([
      '  1 failing',
      '  1) secret leak canary',
      '       "before all" hook for "(a) logs in":',
      '     Error: spawn docker ENOENT',
      '      AssertionError [ERR_ASSERTION]: the logs have no lines',
      '      + expected - actual',
      '      -false',
      '      +true',
      '      at Context.<anonymous> (out/test/extension/x.test.js:12:3)',
    ]);
  });

  it('keeps the summary lines of the leak test', () => {
    expect(
      filter([
        '      userData: 79 files, 6588255 bytes, 5236 lines',
        '      decrypted key in the heap while connected: no',
      ]),
    ).toHaveLength(2);
  });

  it('drops everything else, in particular dumps of the environment and trace lines', () => {
    expect(
      filter([
        '  VSCODE_TEST_OPTIONS: \'{"mochaOpts":{}}\',',
        "  PATH: '/usr/bin:/bin',",
        "  HOME: '/tmp/x/h',",
        '\u001b[90m[main 2026-11-18T06:32:42.469Z]\u001b[0m getUnixShellEnvironment#raw {"PATH":"/usr/bin"}',
        '[main 2026-11-18T06:32:42.414Z] resolveShellEnv(): running (macOS/Linux)',
        'DevTools listening on ws://127.0.0.1:32825/devtools/browser/x',
        'Error while resolving configuration file',
        'PATH=/usr/bin',
        '  Test Connection and Disconnect commands',
      ]),
    ).toEqual([]);
  });

  it('removes terminal colors', () => {
    expect(filter(['  \u001b[32m  ✔\u001b[0m\u001b[90m runs\u001b[0m'])).toEqual(['    ✔ runs']);
  });

  it('stops passing failure details at the next exit code', () => {
    expect(
      filter(['  1 failing', 'Exit code:   1', "  PATH: '/usr/bin',", '      -false']),
    ).toEqual(['  1 failing', 'Exit code:   1']);
  });
});
