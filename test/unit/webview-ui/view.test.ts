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
    const node = createNode(
      doc,
      h('div', { class: 'x', title: undefined }, PAYLOAD),
    ) as FakeElement;
    expect(node.children).toEqual([new FakeText(PAYLOAD)]);
    expect([...node.attributes]).toEqual([['class', 'x']]);
  });

  it('sets boolean attributes when true and leaves them out when false', () => {
    const doc = new FakeDocument();
    const node = createNode(
      doc,
      h('input', { type: 'checkbox', checked: true, disabled: false }),
    ) as FakeElement;
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
