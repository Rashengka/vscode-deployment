import { describe, expect, it } from 'vitest';
import { newServerDraft, type ServerDraft, type SftpDraft } from '../../../src/settings/draft';
import type { HostMessage } from '../../../src/settings/protocol';
import {
  ALLOWED_TAGS,
  UnsafeViewError,
  createNode,
  type DocumentLike,
  type ElementLike,
  type NodeLike,
} from '../../../src/webview-ui/dom';
import {
  ALIAS_PREFIX,
  INITIAL_STATE,
  MANUAL_VALUE,
  addListItem,
  closePicker,
  confirmPicker,
  openPicker,
  pickerValue,
  removeListItem,
  selectPickerEntry,
  selectTab,
  setPickerFilter,
  togglePickerFolder,
  updateListItem,
  addServer,
  applyHostMessage,
  isDirty,
  removeServer,
  select,
  startSaving,
  selectConnection,
  toggleDefault,
  updateField,
  type UiState,
} from '../../../src/webview-ui/state';
import { h, renderApp, type ElementNode, type ViewNode } from '../../../src/webview-ui/view';

const PAYLOAD = '<img src=x onerror=alert(1)>';

/** A fake document that records what is created. */
class FakeElement implements ElementLike {
  readonly attributes = new Map<string, string>();
  readonly children: (FakeElement | FakeText)[] = [];
  readonly tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  appendChild(node: NodeLike): unknown {
    this.children.push(node as FakeElement | FakeText);
    return node;
  }
}

class FakeText {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

class FakeDocument implements DocumentLike {
  readonly created: string[] = [];
  createElement(tag: string): FakeElement {
    this.created.push(tag);
    return new FakeElement(tag);
  }
  createTextNode(text: string): FakeText {
    return new FakeText(text);
  }
}

function asFakeElement(node: unknown): FakeElement {
  if (!(node instanceof FakeElement)) {
    throw new Error('Expected createNode to return an element');
  }
  return node;
}

function elements(node: ViewNode): ElementNode[] {
  return typeof node === 'string' ? [] : [node, ...node.children.flatMap(elements)];
}

function texts(node: ViewNode): string[] {
  return typeof node === 'string' ? [node] : node.children.flatMap(texts);
}

function sftp(overrides: Partial<SftpDraft> = {}): SftpDraft {
  return { ...(newServerDraft('sftp', 's1', []) as SftpDraft), ...overrides };
}

function stateWith(servers: readonly ServerDraft[], overrides: Partial<HostMessage> = {}): UiState {
  return applyHostMessage(INITIAL_STATE, {
    type: 'state',
    folderName: 'app',
    saved: servers,
    draft: servers,
    aliases: ['app', 'staging'],
    aliasProblem: null,
    problem: null,
    changedOnDisk: false,
    notice: null,
    errors: [],
    ...overrides,
  } as HostMessage);
}

describe('rendering untrusted text', () => {
  const hostile = stateWith(
    [
      sftp({ name: PAYLOAD, sshConfigHost: PAYLOAD, rootPath: PAYLOAD, identityFile: PAYLOAD }),
      { ...newServerDraft('inplace', 'i1', []), name: `${PAYLOAD}2` },
    ],
    {
      aliases: [PAYLOAD],
      aliasProblem: PAYLOAD,
      problem: null,
      errors: [{ serverId: 's1', field: 'name', message: PAYLOAD }],
    },
  );
  const withTests = applyHostMessage(hostile, {
    type: 'testStatus',
    id: 's1',
    state: 'failed',
    text: PAYLOAD,
  });

  it('keeps a server name like <img onerror> as text and never creates the element', () => {
    const tree = renderApp(withTests);
    expect(elements(tree).map((element) => element.tag)).not.toContain('img');
    expect(texts(tree)).toContain(PAYLOAD);

    const doc = new FakeDocument();
    createNode(doc, tree);
    expect(doc.created).not.toContain('img');
    expect(doc.created.every((tag) => ALLOWED_TAGS.has(tag))).toBe(true);
  });

  it('puts values into attributes only as values, never as event handlers', () => {
    for (const element of elements(renderApp(withTests))) {
      for (const name of Object.keys(element.attrs)) {
        expect(name).not.toMatch(/^on|^style$|^src$|^href$/i);
      }
    }
  });

  it('renders the error banner and the in-place form with the same payload as text', () => {
    const inplace = select(withTests, 'i1');
    const tree = renderApp(inplace);
    expect(texts(tree)).toContain(`${PAYLOAD}2`);
    expect(elements(tree).map((element) => element.tag)).not.toContain('img');
  });
});

describe('createNode', () => {
  it('creates text nodes for strings', () => {
    const doc = new FakeDocument();
    const node = asFakeElement(
      createNode(doc, h('div', { class: 'x', title: undefined }, PAYLOAD)),
    );
    expect(node.children).toEqual([new FakeText(PAYLOAD)]);
    expect([...node.attributes]).toEqual([['class', 'x']]);
  });

  it('sets boolean attributes when true and leaves them out when false', () => {
    const doc = new FakeDocument();
    const node = asFakeElement(
      createNode(doc, h('input', { type: 'checkbox', checked: true, disabled: false })),
    );
    expect([...node.attributes]).toEqual([
      ['type', 'checkbox'],
      ['checked', ''],
    ]);
  });

  it.each(['script', 'img', 'iframe', 'a', 'style', 'object', 'form', 'svg'])(
    'refuses the element %s',
    (tag) => {
      expect(() => createNode(new FakeDocument(), h(tag))).toThrow(UnsafeViewError);
    },
  );

  it.each(['onclick', 'onerror', 'style', 'src', 'href', 'formaction', 'srcdoc', 'data-x1'])(
    'refuses the attribute %s',
    (name) => {
      expect(() => createNode(new FakeDocument(), h('div', { [name]: 'alert(1)' }))).toThrow(
        UnsafeViewError,
      );
    },
  );
});

describe('settings view', () => {
  it('lists the servers with the default marked, and shows the selected one', () => {
    const tree = renderApp(stateWith([sftp({ name: 'Production' })]));
    const list = elements(tree).find((element) => element.attrs['class'] === 'server-list');
    expect(list && texts(list)).toEqual(['★', 'Production', 'SFTP']);
    expect(texts(tree)).toContain('Test Connection');
    expect(
      elements(tree).find((element) => element.attrs['data-field'] === 'host'),
    ).toBeUndefined();
  });

  it('shows the manual fields only for a manual connection', () => {
    const state = selectConnection(stateWith([sftp()]), 's1', MANUAL_VALUE);
    const fields = elements(renderApp(state)).map((element) => element.attrs['data-field']);
    expect(fields).toEqual(expect.arrayContaining(['host', 'port', 'user', 'identityFile']));
  });

  it('keeps an alias that is no longer in the SSH config selectable', () => {
    const tree = renderApp(stateWith([sftp({ sshConfigHost: 'gone' })]));
    expect(texts(tree)).toContain('gone (not found in the SSH config)');
  });

  it('shows the problem instead of the form when the configuration cannot be edited', () => {
    const tree = renderApp(stateWith([], { problem: 'not valid' }));
    expect(texts(tree)).toContain('not valid');
    const save = elements(tree).find((element) => element.attrs['data-action'] === 'save');
    expect(save?.attrs['disabled']).toBe(true);
    expect(
      elements(tree).find((element) => element.attrs['data-action'] === 'add'),
    ).toBeUndefined();
  });

  it('shows the changed-on-disk banner with Reload', () => {
    const state = applyHostMessage(stateWith([]), { type: 'changedOnDisk' });
    const tree = renderApp(state);
    expect(texts(tree)).toContain('The configuration was changed on disk outside this panel.');
    expect(elements(tree).some((element) => element.attrs['data-action'] === 'reload')).toBe(true);
  });

  it('asks before removing a server and before discarding changes, Cancel focused', () => {
    const base = stateWith([sftp({ name: 'Production' })]);
    for (const confirm of [{ kind: 'remove', id: 's1' }, { kind: 'discard' }] as const) {
      const tree = renderApp({ ...base, confirm });
      const focused = elements(tree).find((element) => element.attrs['data-autofocus'] === 'true');
      expect(focused && texts(focused)).toEqual(['Cancel']);
    }
  });
});

describe('settings state', () => {
  it('edits fields and tracks unsaved changes', () => {
    const state = stateWith([sftp()]);
    expect(isDirty(state)).toBe(false);
    const edited = updateField(state, 's1', 'rootPath', '/home/deploy');
    expect(isDirty(edited)).toBe(true);
    expect(updateField(edited, 's1', 'rootPath', '')).toMatchObject({ draft: state.draft });
  });

  it('never changes the id, type, mode or default through a text field', () => {
    const state = stateWith([sftp()]);
    for (const field of ['id', 'type', 'mode', 'default', 'folder', '__proto__']) {
      expect(updateField(state, 's1', field, 'x').draft).toEqual(state.draft);
    }
  });

  it('switches between an alias and a manual connection', () => {
    const state = stateWith([sftp()]);
    const manual = selectConnection(state, 's1', MANUAL_VALUE);
    expect(manual.draft[0]).toMatchObject({ mode: 'manual' });
    const alias = selectConnection(manual, 's1', `${ALIAS_PREFIX}staging`);
    expect(alias.draft[0]).toMatchObject({ mode: 'alias', sshConfigHost: 'staging' });
  });

  it('adds, removes and selects servers and keeps one default', () => {
    let state = addServer(stateWith([]), 'sftp', 'a');
    state = addServer(state, 'inplace', 'b');
    expect(state.selectedId).toBe('b');
    expect(state.draft.map((server) => server.default)).toEqual([true, false]);
    state = toggleDefault(state, 'b', true);
    expect(state.draft.map((server) => server.default)).toEqual([false, true]);
    state = removeServer(state, 'b');
    expect(state.draft.map((server) => server.id)).toEqual(['a']);
    expect(state.selectedId).toBe('a');
  });

  it('fills in a picked path and keeps the selection over a new state from the host', () => {
    let state = addServer(stateWith([sftp()]), 'inplace', 'i1');
    state = applyHostMessage(state, {
      type: 'picked',
      id: 'i1',
      field: 'folder',
      path: '/var/www/app',
    });
    expect(state.draft[1]).toMatchObject({ folder: '/var/www/app' });
    state = applyHostMessage(state, {
      type: 'state',
      folderName: 'app',
      saved: state.draft,
      draft: state.draft,
      aliases: [],
      aliasProblem: null,
      problem: null,
      changedOnDisk: false,
      notice: 'Saved.',
      errors: [],
    });
    expect(state.selectedId).toBe('i1');
    expect(isDirty(state)).toBe(false);
  });

  it('disables Save while saving until the host answers', () => {
    const saveButton = (state: UiState): ElementNode | undefined =>
      elements(renderApp(state)).find((element) => element.attrs['data-action'] === 'save');
    const saving = startSaving(stateWith([sftp()]));
    expect(saveButton(saving)?.attrs['disabled']).toBe(true);
    for (const answer of [{ type: 'errors', errors: [] }, { type: 'changedOnDisk' }] as const) {
      expect(saveButton(applyHostMessage(saving, answer))?.attrs['disabled']).toBe(false);
    }
  });

  it('disables Test Connection of every server while one test runs', () => {
    const state = applyHostMessage(
      stateWith([sftp(), sftp({ id: 's2', name: 'Other', default: false })]),
      { type: 'testStatus', id: 's2', state: 'running', text: 'Connecting…' },
    );
    const test = elements(renderApp(state)).find(
      (element) => element.attrs['data-action'] === 'test',
    );
    expect(state.selectedId).toBe('s1');
    expect(test?.attrs['disabled']).toBe(true);
  });

  it('enables Save again after a failed or interrupted save', () => {
    const saving = startSaving(stateWith([sftp()]));
    const failed = applyHostMessage(saving, { type: 'saveFailed', message: 'Too large.' });
    expect(failed.saving).toBe(false);
    expect(failed.errors).toEqual([{ serverId: null, field: null, message: 'Too large.' }]);
    const saved = applyHostMessage(saving, { type: 'saved' });
    expect(saved).toMatchObject({ saving: false, notice: 'Saved.', saved: saving.draft });
  });
});

const SESSION = 'd'.repeat(32);

function withMappings(): UiState {
  return selectTab(
    stateWith([
      sftp({
        rootPath: '/home/deploy',
        mappings: [{ localPath: '.', deploymentPath: 'www/app' }],
        excludedLocalPaths: ['vendor'],
        excludedRemotePaths: [],
      }),
    ]),
    'mappings',
  );
}

function listed(
  state: UiState,
  path: string,
  entries: Extract<HostMessage, { type: 'remoteListing' }>['entries'],
): UiState {
  return applyHostMessage(state, {
    type: 'remoteListing',
    session: SESSION,
    base: '/home/deploy',
    path,
    entries,
    truncated: false,
  });
}

describe('Mappings and Excluded Paths tabs', () => {
  it('shows the mappings with the root path in the hint, and the tab buttons', () => {
    const tree = renderApp(withMappings());
    expect(texts(tree)).toEqual(
      expect.arrayContaining([
        'Connection',
        'Mappings',
        'Excluded Paths',
        'Local path is relative to the project. Deployment path is relative to the server root path (/home/deploy).',
        'Add New Mapping',
        'Verify Mapping',
      ]),
    );
    const inputs = elements(tree).filter(
      (element) => element.attrs['data-list'] === 'mappings' && element.tag === 'input',
    );
    expect(inputs.map((input) => [input.attrs['data-key'], input.attrs['value']])).toEqual([
      ['localPath', '.'],
      ['deploymentPath', 'www/app'],
    ]);
  });

  it('adds, edits and removes rows', () => {
    let state = addListItem(withMappings(), 's1', 'mappings');
    state = updateListItem(state, 's1', 'mappings', 1, 'deploymentPath', 'www/static');
    state = addListItem(state, 's1', 'excludedRemotePaths');
    state = updateListItem(state, 's1', 'excludedRemotePaths', 0, null, 'cache');
    let server = state.draft[0] as SftpDraft;
    expect(server.mappings).toEqual([
      { localPath: '.', deploymentPath: 'www/app' },
      { localPath: '.', deploymentPath: 'www/static' },
    ]);
    expect(server.excludedRemotePaths).toEqual(['cache']);
    expect(isDirty(state)).toBe(true);

    state = removeListItem(state, 's1', 'mappings', 0);
    server = state.draft[0] as SftpDraft;
    expect(server.mappings).toEqual([{ localPath: '.', deploymentPath: 'www/static' }]);
  });

  it('ignores edits of rows and columns that do not exist', () => {
    const state = withMappings();
    expect(updateListItem(state, 's1', 'mappings', 5, 'localPath', 'x').draft).toEqual(state.draft);
    expect(updateListItem(state, 's1', 'mappings', 0, 'id', 'x').draft).toEqual(state.draft);
    expect(updateListItem(state, 's1', 'excludedLocalPaths', 0, 'localPath', 'x').draft).toEqual(
      state.draft,
    );
    expect(updateField(state, 's1', 'mappings', 'x').draft).toEqual(state.draft);
  });

  it('shows an error under the row it belongs to and marks the tab', () => {
    const state = applyHostMessage(withMappings(), {
      type: 'errors',
      errors: [{ serverId: 's1', field: 'mappings.0.localPath', message: PAYLOAD }],
    });
    const tree = renderApp(state);
    const error = elements(tree).find(
      (element) => element.attrs['id'] === 'error-mappings.0.localPath',
    );
    expect(error && texts(error)).toEqual([PAYLOAD]);
    const tab = elements(tree).find((element) => element.attrs['data-tab'] === 'mappings');
    expect(tab && texts(tab)).toEqual(['Mappings', ' !']);
  });

  it('applies a path picked in the project to its row', () => {
    const state = applyHostMessage(withMappings(), {
      type: 'pickedItem',
      id: 's1',
      list: 'mappings',
      index: 0,
      path: 'public',
    });
    expect((state.draft[0] as SftpDraft).mappings[0]?.localPath).toBe('public');
  });

  it('shows the result of Verify Mapping with the missing files as text', () => {
    const state = applyHostMessage(withMappings(), {
      type: 'verifyResult',
      id: 's1',
      source: 'git',
      truncated: false,
      checks: [
        {
          localPath: '.',
          deploymentPath: 'www/app',
          checked: 20,
          found: 18,
          verdict: 'correct',
          text: '18/20 files found – mapping looks correct',
          missing: [PAYLOAD, 'src/b.php'],
          unchecked: [],
        },
      ],
    });
    const tree = renderApp(state);
    expect(texts(tree)).toEqual(
      expect.arrayContaining(['18/20 files found – mapping looks correct', PAYLOAD, 'src/b.php']),
    );
    expect(elements(tree).map((element) => element.tag)).not.toContain('img');
  });

  it('shows the excluded paths of both kinds', () => {
    const tree = renderApp(selectTab(withMappings(), 'excluded'));
    expect(texts(tree)).toEqual(
      expect.arrayContaining(['Local excluded paths', 'Remote excluded paths', 'Add Remote Path']),
    );
    const local = elements(tree).find(
      (element) => element.attrs['data-list'] === 'excludedLocalPaths' && element.tag === 'input',
    );
    expect(local?.attrs['value']).toBe('vendor');
  });
});

describe('remote folder picker', () => {
  const entries = [
    { name: 'www', label: 'www', kind: 'directory' as const, usable: true },
    { name: 'current', label: 'current', kind: 'symlink' as const, usable: true },
    { name: PAYLOAD, label: PAYLOAD, kind: 'directory' as const, usable: true },
    { name: 'rtl\u202e', label: 'rtl\\u202e', kind: 'directory' as const, usable: false },
    { name: 'notes.txt', label: 'notes.txt', kind: 'file' as const, usable: true },
  ];

  function opened(purpose: 'mapping' | 'rootPath' | 'excludedRemote' = 'mapping'): UiState {
    return listed(openPicker(withMappings(), 's1', purpose, 0), '', entries);
  }

  it('renders a server name like <img onerror> as text and never creates the element', () => {
    const tree = renderApp(opened());
    expect(texts(tree)).toContain(`${PAYLOAD}/`);
    expect(elements(tree).map((element) => element.tag)).not.toContain('img');
    const doc = new FakeDocument();
    createNode(doc, tree);
    expect(doc.created).not.toContain('img');
    expect(doc.created.every((tag) => ALLOWED_TAGS.has(tag))).toBe(true);
  });

  it('opens folders but not symbolic links, files or unusable names', () => {
    const tree = renderApp(opened());
    const toggles = elements(tree)
      .filter((element) => element.attrs['data-action'] === 'pickerToggle')
      .map((element) => element.attrs['data-path']);
    expect(toggles).toEqual(['www', PAYLOAD]);
    const choosable = elements(tree)
      .filter(
        (element) =>
          element.attrs['data-action'] === 'pickerSelect' && element.attrs['disabled'] !== true,
      )
      .map((element) => element.attrs['data-path']);
    expect(choosable).toEqual(['', 'www', PAYLOAD]);
    expect(texts(tree)).toContain('current (symbolic link)');
    expect(texts(tree)).toContain('rtl\\u202e/ (unusable name)');
  });

  it('lets an exclusion be a file or a link, and not the base folder', () => {
    const tree = renderApp(opened('excludedRemote'));
    const choosable = elements(tree)
      .filter(
        (element) =>
          element.attrs['data-action'] === 'pickerSelect' && element.attrs['disabled'] !== true,
      )
      .map((element) => element.attrs['data-path']);
    expect(choosable).toEqual(['www', 'current', PAYLOAD, 'notes.txt']);
  });

  it('asks for a folder once when it is opened, and shows its entries', () => {
    const first = togglePickerFolder(opened(), 'www');
    expect(first.list).toBe(true);
    expect(texts(renderApp(first.state))).toContain('Loading…');
    const loaded = listed(first.state, 'www', [
      { name: 'html', label: 'html', kind: 'directory', usable: true },
    ]);
    expect(texts(renderApp(loaded))).toContain('html/');
    const closed = togglePickerFolder(loaded, 'www');
    expect(closed.list).toBe(false);
    expect(togglePickerFolder(closed.state, 'www').list).toBe(false);
  });

  it('filters the entries by name', () => {
    const tree = renderApp(setPickerFilter(opened(), 'WW'));
    expect(texts(tree)).toContain('www/');
    expect(texts(tree)).not.toContain('notes.txt');
  });

  it('ignores a listing of another session', () => {
    const state = listed(opened(), 'www', []);
    const other = applyHostMessage(state, {
      type: 'remoteListing',
      session: 'e'.repeat(32),
      base: '/',
      path: '',
      entries: [],
      truncated: false,
    });
    expect(other).toEqual(state);
  });

  it('shows a connection failure and only allows Cancel', () => {
    const state = applyHostMessage(openPicker(withMappings(), 's1', 'mapping', 0), {
      type: 'remoteError',
      session: null,
      path: '',
      message: PAYLOAD,
    });
    const tree = renderApp(state);
    expect(texts(tree)).toContain(PAYLOAD);
    const ok = elements(tree).find((element) => element.attrs['data-action'] === 'pickerOk');
    expect(ok?.attrs['disabled']).toBe(true);
  });

  it('puts the chosen folder into the mapping, relative to the root path', () => {
    let state = selectPickerEntry(opened(), 'www/html', 'directory');
    expect(state.picker && pickerValue(state.picker)).toBe('www/html');
    state = confirmPicker(state);
    expect(state.picker).toBeNull();
    expect((state.draft[0] as SftpDraft).mappings[0]?.deploymentPath).toBe('www/html');

    const base = confirmPicker(selectPickerEntry(opened(), '', 'directory'));
    expect((base.draft[0] as SftpDraft).mappings[0]?.deploymentPath).toBe('.');
  });

  it('gives an absolute root path from the server root', () => {
    const state = confirmPicker(selectPickerEntry(opened('rootPath'), 'var/www', 'directory'));
    expect((state.draft[0] as SftpDraft).rootPath).toBe('/var/www');
    const root = confirmPicker(selectPickerEntry(opened('rootPath'), '', 'directory'));
    expect((root.draft[0] as SftpDraft).rootPath).toBe('/');
  });

  it('does not choose a file for a mapping, and Cancel changes nothing', () => {
    const state = selectPickerEntry(opened(), 'notes.txt', 'file');
    expect(state.picker?.selected).toBeNull();
    expect(closePicker(state).draft).toEqual(withMappings().draft);
  });
});

describe('states that must not get stuck or look fine', () => {
  const unchecked = {
    localPath: '.',
    deploymentPath: 'www/app',
    checked: 0,
    found: 0,
    verdict: 'unchecked' as const,
    text: 'None of the 1 files could be checked',
    missing: [],
    unchecked: [{ path: PAYLOAD, reason: 'Permission denied' }],
  };

  it('shows the files that could not be checked and that the file list was cut off', () => {
    const state = applyHostMessage(withMappings(), {
      type: 'verifyResult',
      id: 's1',
      source: 'workspace',
      truncated: true,
      checks: [unchecked],
    });
    const tree = renderApp(state);
    expect(texts(tree)).toEqual(
      expect.arrayContaining([
        'Could not be checked (1)',
        `${PAYLOAD}: Permission denied`,
        'The project has more files than were listed; the sample comes from the first ones.',
      ]),
    );
    expect(elements(tree).map((element) => element.tag)).not.toContain('img');
  });

  it('forgets running operations when the state is sent again', () => {
    let state = applyHostMessage(withMappings(), {
      type: 'taskStatus',
      id: 's1',
      task: 'verify',
      state: 'running',
      text: 'Looking up…',
    });
    state = applyHostMessage(state, {
      type: 'testStatus',
      id: 's1',
      state: 'running',
      text: 'Connecting…',
    });
    const verify = (): ElementNode | undefined =>
      elements(renderApp(state)).find((element) => element.attrs['data-action'] === 'verify');
    expect(verify()?.attrs['disabled']).toBe(true);
    state = applyHostMessage(state, {
      type: 'state',
      folderName: 'app',
      saved: state.saved,
      draft: state.draft,
      aliases: [],
      aliasProblem: null,
      problem: null,
      changedOnDisk: false,
      notice: null,
      errors: [],
    });
    expect(verify()?.attrs['disabled']).toBe(false);
  });

  it('drops the results and the picker of servers that are no longer in the form', () => {
    let state = applyHostMessage(withMappings(), {
      type: 'verifyResult',
      id: 's1',
      source: 'git',
      truncated: false,
      checks: [unchecked],
    });
    state = openPicker(state, 's1', 'mapping', 0);
    state = applyHostMessage(state, {
      type: 'state',
      folderName: 'app',
      saved: [],
      draft: [],
      aliases: [],
      aliasProblem: null,
      problem: null,
      changedOnDisk: false,
      notice: null,
      errors: [],
    });
    expect(state.verify.size).toBe(0);
    expect(state.picker).toBeNull();
  });

  it('stops the tree when the connection of the picker is lost', () => {
    const open = listed(openPicker(withMappings(), 's1', 'mapping', 0), '', [
      { name: 'www', label: 'www', kind: 'directory', usable: true },
    ]);
    const lost = applyHostMessage(selectPickerEntry(open, 'www', 'directory'), {
      type: 'remoteError',
      session: null,
      path: 'www',
      message: 'The connection of the folder picker was closed.',
    });
    const tree = renderApp(lost);
    expect(texts(tree)).toContain('The connection of the folder picker was closed.');
    expect(elements(tree).some((element) => element.attrs['data-action'] === 'pickerToggle')).toBe(
      false,
    );
    const ok = elements(tree).find((element) => element.attrs['data-action'] === 'pickerOk');
    expect(ok?.attrs['disabled']).toBe(true);
    expect(lost.picker && pickerValue(lost.picker)).toBeNull();
    expect(togglePickerFolder(lost, 'www').list).toBe(false);
  });
});
