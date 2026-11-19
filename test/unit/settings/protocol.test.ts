import { describe, expect, it } from 'vitest';
import {
  newServerDraft,
  sameDrafts,
  setDefault,
  uniqueName,
  type ServerDraft,
  type SftpDraft,
} from '../../../src/settings/draft';
import {
  MAX_LIST_ITEMS,
  MAX_MESSAGE_SIZE,
  MAX_SERVERS,
  MAX_TEXT_LENGTH,
  exceedsSize,
  parseWebviewMessage,
} from '../../../src/settings/protocol';

const sftp = newServerDraft('sftp', 's1', []) as SftpDraft;
const inplace = newServerDraft('inplace', 'i1', [sftp]);

describe('parseWebviewMessage', () => {
  it.each([
    { type: 'ready' },
    { type: 'reload' },
    { type: 'draft', servers: [sftp, inplace] },
    { type: 'save', servers: [] },
    { type: 'pickPath', id: 's1', field: 'identityFile' },
    { type: 'pickPath', id: 'i1', field: 'folder' },
    { type: 'testConnection', server: sftp },
  ])('accepts $type', (message) => {
    expect(parseWebviewMessage(message)).toEqual({ ok: true, message });
  });

  it.each([
    ['not an object', 'ready'],
    ['null', null],
    ['an array', [{ type: 'ready' }]],
    ['no type', {}],
    ['an unknown type', { type: 'runCommand', command: 'workbench.action.terminal.new' }],
    ['a type from the prototype', { type: 'toString' }],
  ])('drops %s without naming its type', (_what, message) => {
    expect(parseWebviewMessage(message)).toEqual({ ok: false, type: null });
  });

  it.each([
    ['an extra property', { type: 'ready', extra: 1 }],
    ['servers that are not an array', { type: 'save', servers: {} }],
    ['a server with an extra property', { type: 'save', servers: [{ ...sftp, password: 'x' }] }],
    ['a server with a missing property', { type: 'save', servers: [{ ...sftp, port: undefined }] }],
    ['a number where text belongs', { type: 'save', servers: [{ ...sftp, port: 22 }] }],
    ['an unknown server type', { type: 'save', servers: [{ ...sftp, type: 'ftp' }] }],
    ['an unknown connection mode', { type: 'save', servers: [{ ...sftp, mode: 'agent' }] }],
    ['an empty id', { type: 'save', servers: [{ ...sftp, id: '' }] }],
    ['duplicate ids', { type: 'save', servers: [sftp, { ...inplace, id: 's1' }] }],
    [
      'too many servers',
      {
        type: 'draft',
        servers: Array.from({ length: MAX_SERVERS + 1 }, (_, i) => ({ ...sftp, id: `s${i}` })),
      },
    ],
    [
      'text that is too long',
      { type: 'save', servers: [{ ...sftp, name: 'x'.repeat(MAX_TEXT_LENGTH + 1) }] },
    ],
    ['an unknown path field', { type: 'pickPath', id: 's1', field: 'rootPath' }],
    ['Test Connection of an in-place server', { type: 'testConnection', server: inplace }],
  ])('refuses %s', (_what, message) => {
    const result = parseWebviewMessage(message);
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.type).toBe((message as { type: string }).type);
  });
});

describe('drafts', () => {
  it('makes the first server the default and gives new servers unique names', () => {
    expect(sftp.default).toBe(true);
    expect(inplace.default).toBe(false);
    const servers: ServerDraft[] = [sftp, { ...sftp, id: 's2', name: 'new server 2' }];
    expect(uniqueName('New Server', servers)).toBe('New Server 3');
    expect(newServerDraft('sftp', 's3', servers).name).toBe('New Server 3');
  });

  it('keeps at most one default', () => {
    const servers = setDefault([sftp, inplace], 'i1', true);
    expect(servers.map((server) => server.default)).toEqual([false, true]);
    expect(setDefault(servers, 'i1', false).map((server) => server.default)).toEqual([
      false,
      false,
    ]);
  });

  it('compares drafts field by field', () => {
    expect(sameDrafts([sftp, inplace], [{ ...sftp }, { ...inplace }])).toBe(true);
    expect(sameDrafts([sftp, inplace], [inplace, sftp])).toBe(false);
    expect(sameDrafts([sftp], [{ ...sftp, port: '22' }])).toBe(false);
    expect(sameDrafts([sftp], [])).toBe(false);
  });
});

describe('exceedsSize', () => {
  it('accepts every valid message up to the limits of the schema', () => {
    const servers = Array.from({ length: 20 }, (_, i) => ({ ...sftp, id: `s${i}` }));
    expect(exceedsSize({ type: 'save', servers }, MAX_MESSAGE_SIZE)).toBe(false);
  });

  it('refuses long text, many entries and deep nesting', () => {
    expect(
      exceedsSize({ type: 'x', text: 'x'.repeat(MAX_MESSAGE_SIZE + 1) }, MAX_MESSAGE_SIZE),
    ).toBe(true);
    expect(
      exceedsSize(
        Array.from({ length: 200_000 }, () => 1),
        MAX_MESSAGE_SIZE,
      ),
    ).toBe(true);
    let deep: unknown = 'x';
    for (let i = 0; i < 20; i++) {
      deep = [deep];
    }
    expect(exceedsSize(deep, MAX_MESSAGE_SIZE)).toBe(true);
  });
});

describe('messages of the Mappings and Excluded Paths tabs', () => {
  const mapped: SftpDraft = {
    ...sftp,
    mappings: [{ localPath: '.', deploymentPath: 'www/app' }],
    excludedLocalPaths: ['.git'],
    excludedRemotePaths: ['cache'],
  };
  const session = 'a'.repeat(32);

  it.each([
    { type: 'save', servers: [mapped] },
    { type: 'pickProjectPath', id: 's1', list: 'mappings', index: 0 },
    { type: 'pickProjectPath', id: 's1', list: 'excludedLocalPaths', index: 3 },
    { type: 'autodetectRoot', server: mapped },
    { type: 'verifyMapping', server: mapped },
    { type: 'browseRemote', server: mapped, purpose: 'rootPath', index: 0 },
    { type: 'browseRemote', server: mapped, purpose: 'mapping', index: 0 },
    { type: 'browseRemote', server: mapped, purpose: 'excludedRemote', index: 2 },
    { type: 'remoteList', session, path: '' },
    { type: 'remoteList', session, path: 'www/app' },
    { type: 'remoteClose' },
  ])('accepts $type', (message) => {
    expect(parseWebviewMessage(message)).toEqual({ ok: true, message });
  });

  it.each([
    [
      'a mapping with an extra property',
      {
        type: 'save',
        servers: [{ ...mapped, mappings: [{ localPath: '.', deploymentPath: '', remote: 'x' }] }],
      },
    ],
    [
      'a mapping that is not an object',
      { type: 'save', servers: [{ ...mapped, mappings: ['.'] }] },
    ],
    [
      'an excluded path that is not text',
      { type: 'save', servers: [{ ...mapped, excludedLocalPaths: [1] }] },
    ],
    [
      'excluded paths that are not a list',
      { type: 'save', servers: [{ ...mapped, excludedRemotePaths: 'cache' }] },
    ],
    [
      'too many mappings',
      {
        type: 'save',
        servers: [
          {
            ...mapped,
            mappings: Array.from({ length: MAX_LIST_ITEMS + 1 }, () => ({
              localPath: '.',
              deploymentPath: '',
            })),
          },
        ],
      },
    ],
    [
      'a local pick for a remote list',
      { type: 'pickProjectPath', id: 's1', list: 'excludedRemotePaths', index: 0 },
    ],
    ['a negative row', { type: 'pickProjectPath', id: 's1', list: 'mappings', index: -1 }],
    ['a fractional row', { type: 'pickProjectPath', id: 's1', list: 'mappings', index: 0.5 }],
    [
      'a row beyond the limit',
      { type: 'pickProjectPath', id: 's1', list: 'mappings', index: MAX_LIST_ITEMS },
    ],
    ['Autodetect of an in-place server', { type: 'autodetectRoot', server: inplace }],
    ['Verify Mapping of an in-place server', { type: 'verifyMapping', server: inplace }],
    [
      'an unknown browse purpose',
      { type: 'browseRemote', server: mapped, purpose: 'home', index: 0 },
    ],
    ['a browse without a row', { type: 'browseRemote', server: mapped, purpose: 'mapping' }],
    ['a listing with a malformed session', { type: 'remoteList', session: 'x', path: '' }],
    ['a listing with a path that is not text', { type: 'remoteList', session, path: ['www'] }],
    [
      'a listing with a too long path',
      { type: 'remoteList', session, path: 'x'.repeat(MAX_TEXT_LENGTH + 1) },
    ],
    ['a close with a property', { type: 'remoteClose', session }],
  ])('refuses %s', (_what, message) => {
    const result = parseWebviewMessage(message);
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.type).toBe((message as { type: string }).type);
  });

  it('compares mappings and excluded paths of drafts', () => {
    expect(
      sameDrafts(
        [mapped],
        [{ ...mapped, mappings: [{ localPath: '.', deploymentPath: 'www/app' }] }],
      ),
    ).toBe(true);
    expect(
      sameDrafts([mapped], [{ ...mapped, mappings: [{ localPath: '.', deploymentPath: 'www' }] }]),
    ).toBe(false);
    expect(sameDrafts([mapped], [{ ...mapped, mappings: [] }])).toBe(false);
    expect(sameDrafts([mapped], [{ ...mapped, excludedLocalPaths: ['.git', 'vendor'] }])).toBe(
      false,
    );
  });
});
