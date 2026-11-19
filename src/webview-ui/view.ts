/**
 * Rendering of the settings webview as a plain tree of elements and text, without the DOM.
 *
 * Every value that comes from the configuration, the SSH config or a server (names, hosts,
 * paths, messages) is a text child here, and `dom.ts` turns text children into text nodes only:
 * no value is ever parsed as HTML. Elements carry no event handlers; `main.ts` handles events by
 * delegation, using the `data-action` and `data-field` attributes.
 */
import type { InplaceDraft, ServerDraft, SftpDraft } from '../settings/draft';
import type { FormError } from '../settings/protocol';
import { ALIAS_PREFIX, MANUAL_VALUE, isDirty, selectedServer, type UiState } from './state';

export type AttributeValue = string | boolean | undefined;

export interface ElementNode {
  readonly tag: string;
  readonly attrs: Readonly<Record<string, AttributeValue>>;
  readonly children: readonly ViewNode[];
}

/** A string is a text node. */
export type ViewNode = ElementNode | string;

export function h(
  tag: string,
  attrs: Readonly<Record<string, AttributeValue>> = {},
  ...children: readonly (ViewNode | null | false)[]
): ElementNode {
  return {
    tag,
    attrs,
    children: children.filter((child): child is ViewNode => child !== null && child !== false),
  };
}

function fieldError(errors: readonly FormError[], id: string, field: string): ElementNode | null {
  const messages = errors
    .filter((error) => error.serverId === id && error.field === field)
    .map((error) => error.message);
  return messages.length === 0
    ? null
    : h('div', { class: 'field-error', id: `error-${field}` }, messages.join(' '));
}

function hasError(errors: readonly FormError[], id: string, field: string): boolean {
  return errors.some((error) => error.serverId === id && error.field === field);
}

interface TextFieldOptions {
  readonly label: string;
  readonly field: string;
  readonly value: string;
  readonly placeholder?: string;
  readonly hint?: string;
  readonly inputmode?: string;
  /** A button after the input (for example a picker). */
  readonly button?: ElementNode;
}

function textField(state: UiState, server: ServerDraft, options: TextFieldOptions): ElementNode {
  const id = `field-${options.field}`;
  const invalid = hasError(state.errors, server.id, options.field);
  const input = h('input', {
    type: 'text',
    id,
    value: options.value,
    placeholder: options.placeholder,
    inputmode: options.inputmode,
    spellcheck: 'false',
    autocomplete: 'off',
    'data-field': options.field,
    'aria-invalid': invalid ? 'true' : undefined,
    'aria-describedby': invalid ? `error-${options.field}` : undefined,
  });
  return h(
    'div',
    { class: 'field' },
    h('label', { for: id }, options.label),
    options.button === undefined
      ? input
      : h('div', { class: 'with-button' }, input, options.button),
    options.hint === undefined ? null : h('div', { class: 'hint' }, options.hint),
    fieldError(state.errors, server.id, options.field),
  );
}

function defaultField(server: ServerDraft): ElementNode {
  return h(
    'div',
    { class: 'field checkbox' },
    h('input', {
      type: 'checkbox',
      id: 'field-default',
      checked: server.default,
      'data-field': 'default',
    }),
    h('label', { for: 'field-default' }, 'Default server'),
  );
}

function connectionSelect(state: UiState, server: SftpDraft): ElementNode {
  const manual = server.mode === 'manual';
  const selectedAlias = manual ? null : server.sshConfigHost;
  const known = state.aliases.some((alias) => alias === selectedAlias);
  const options: ElementNode[] = [
    h(
      'option',
      { value: '', selected: !manual && selectedAlias === '', disabled: true },
      'Choose an SSH config host…',
    ),
    ...state.aliases.map((alias) =>
      h('option', { value: `${ALIAS_PREFIX}${alias}`, selected: alias === selectedAlias }, alias),
    ),
  ];
  if (!manual && selectedAlias !== null && selectedAlias !== '' && !known) {
    options.push(
      h(
        'option',
        { value: `${ALIAS_PREFIX}${selectedAlias}`, selected: true },
        `${selectedAlias} (not found in the SSH config)`,
      ),
    );
  }
  options.push(h('option', { value: MANUAL_VALUE, selected: manual }, 'Manual…'));
  const invalid = hasError(state.errors, server.id, 'sshConfigHost');
  return h(
    'div',
    { class: 'field' },
    h('label', { for: 'field-connection' }, 'Connection'),
    h(
      'select',
      {
        id: 'field-connection',
        'data-field': 'connection',
        'aria-invalid': invalid ? 'true' : undefined,
        'aria-describedby': invalid ? 'error-sshConfigHost' : undefined,
      },
      ...options,
    ),
    state.aliasProblem === null ? null : h('div', { class: 'hint warning' }, state.aliasProblem),
    fieldError(state.errors, server.id, 'sshConfigHost'),
  );
}

function testConnection(state: UiState, server: SftpDraft): ElementNode {
  const status = state.tests[server.id];
  // One Test Connection at a time per panel (the host refuses a second one).
  const running = Object.values(state.tests).some((test) => test.state === 'running');
  return h(
    'div',
    { class: 'field test' },
    h(
      'button',
      { type: 'button', class: 'secondary', 'data-action': 'test', disabled: running },
      'Test Connection',
    ),
    status === undefined
      ? null
      : h('span', { class: `test-status ${status.state}`, role: 'status' }, status.text),
  );
}

function sftpForm(state: UiState, server: SftpDraft): ElementNode {
  const alias = server.mode === 'alias';
  const fromConfig = alias ? 'From the SSH config' : undefined;
  return h(
    'section',
    { class: 'form', 'aria-label': 'Connection' },
    h('h2', {}, 'Connection'),
    textField(state, server, { label: 'Name', field: 'name', value: server.name }),
    connectionSelect(state, server),
    alias
      ? null
      : textField(state, server, {
          label: 'Host',
          field: 'host',
          value: server.host,
          placeholder: 'example.com',
        }),
    textField(state, server, {
      label: 'Port',
      field: 'port',
      value: server.port,
      placeholder: fromConfig ?? '22',
      inputmode: 'numeric',
    }),
    textField(state, server, {
      label: 'User',
      field: 'user',
      value: server.user,
      placeholder: fromConfig ?? 'deploy',
    }),
    textField(state, server, {
      label: 'Identity file',
      field: 'identityFile',
      value: server.identityFile,
      placeholder: fromConfig ?? 'From the SSH config, or the default keys',
      hint: 'The path to a private key file. The passphrase is asked for when connecting and never stored.',
      button: h('button', { type: 'button', class: 'secondary', 'data-action': 'pick' }, 'Browse…'),
    }),
    alias
      ? h(
          'div',
          { class: 'hint' },
          'Port, user and identity file override the SSH config when they are set.',
        )
      : null,
    testConnection(state, server),
    textField(state, server, {
      label: 'Root path',
      field: 'rootPath',
      value: server.rootPath,
      placeholder: '/home/deploy',
      hint: 'Absolute path on the server; deployment paths of the mappings are relative to it.',
    }),
    defaultField(server),
    h(
      'details',
      { class: 'advanced' },
      h('summary', {}, 'Advanced'),
      textField(state, server, {
        label: 'Keep-alive interval (seconds, 0 = off)',
        field: 'keepAliveSeconds',
        value: server.keepAliveSeconds,
        inputmode: 'numeric',
      }),
      textField(state, server, {
        label: 'Idle disconnect (minutes, 0 = keep until the window closes)',
        field: 'idleDisconnectMinutes',
        value: server.idleDisconnectMinutes,
        inputmode: 'numeric',
      }),
    ),
  );
}

function inplaceForm(state: UiState, server: InplaceDraft): ElementNode {
  return h(
    'section',
    { class: 'form', 'aria-label': 'In-place server' },
    h('h2', {}, 'In-place server'),
    h(
      'p',
      { class: 'hint' },
      'The site runs directly from a local folder; nothing is uploaded to it.',
    ),
    textField(state, server, { label: 'Name', field: 'name', value: server.name }),
    textField(state, server, {
      label: 'Folder',
      field: 'folder',
      value: server.folder,
      placeholder: '/var/www/app',
      hint: 'The absolute path of the folder the site runs from.',
      button: h('button', { type: 'button', class: 'secondary', 'data-action': 'pick' }, 'Browse…'),
    }),
    textField(state, server, {
      label: 'Web URL',
      field: 'webUrl',
      value: server.webUrl,
      placeholder: 'http://app.example.com/',
    }),
    defaultField(server),
  );
}

function typeLabel(server: ServerDraft): string {
  return server.type === 'sftp' ? 'SFTP' : 'In-place';
}

function serverList(state: UiState): ElementNode {
  const items = state.draft.map((server) => {
    const selected = server.id === state.selectedId;
    const invalid = state.errors.some((error) => error.serverId === server.id);
    return h(
      'li',
      {},
      h(
        'button',
        {
          type: 'button',
          class: `server${selected ? ' selected' : ''}`,
          'data-action': 'select',
          'data-id': server.id,
          'aria-current': selected ? 'true' : undefined,
        },
        h(
          'span',
          { class: 'default-marker', title: server.default ? 'Default server' : undefined },
          server.default ? '★' : '',
        ),
        h('span', { class: 'server-name' }, server.name.trim() === '' ? '(no name)' : server.name),
        h('span', { class: 'server-type' }, typeLabel(server)),
        invalid ? h('span', { class: 'server-invalid', title: 'Has errors' }, '!') : null,
      ),
    );
  });
  const selected = selectedServer(state);
  return h(
    'nav',
    { class: 'servers', 'aria-label': 'Servers' },
    h(
      'div',
      { class: 'toolbar' },
      h(
        'button',
        {
          type: 'button',
          class: 'icon',
          'data-action': 'add',
          title: 'Add a server',
          'aria-label': 'Add a server',
          'aria-expanded': state.addMenuOpen ? 'true' : 'false',
        },
        '+',
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'icon',
          'data-action': 'remove',
          title: 'Remove the selected server',
          'aria-label': 'Remove the selected server',
          disabled: selected === undefined,
        },
        '−',
      ),
    ),
    state.addMenuOpen
      ? h(
          'div',
          { class: 'add-menu', role: 'group', 'aria-label': 'Server type' },
          h(
            'button',
            {
              type: 'button',
              'data-action': 'addType',
              'data-type': 'sftp',
              'data-autofocus': 'true',
            },
            'SFTP',
          ),
          h(
            'button',
            { type: 'button', 'data-action': 'addType', 'data-type': 'inplace' },
            'In-place',
          ),
        )
      : null,
    items.length === 0
      ? h('p', { class: 'hint empty' }, 'No servers yet.')
      : h('ul', { class: 'server-list' }, ...items),
  );
}

function confirmBar(state: UiState): ElementNode | null {
  const { confirm } = state;
  if (confirm === null) {
    return null;
  }
  if (confirm.kind === 'remove') {
    const server = state.draft.find((candidate) => candidate.id === confirm.id);
    if (server === undefined) {
      return null;
    }
    return h(
      'div',
      { class: 'banner confirm', role: 'alertdialog', 'aria-label': 'Remove server' },
      h(
        'span',
        {},
        `Remove the server "${server.name}"? It is deleted from the configuration when you save.`,
      ),
      h('button', { type: 'button', 'data-action': 'confirmRemove' }, 'Remove'),
      h(
        'button',
        {
          type: 'button',
          class: 'secondary',
          'data-action': 'cancelConfirm',
          'data-autofocus': 'true',
        },
        'Cancel',
      ),
    );
  }
  return h(
    'div',
    { class: 'banner confirm', role: 'alertdialog', 'aria-label': 'Discard changes' },
    h('span', {}, 'Discard all unsaved changes?'),
    h('button', { type: 'button', 'data-action': 'confirmDiscard' }, 'Discard'),
    h(
      'button',
      {
        type: 'button',
        class: 'secondary',
        'data-action': 'cancelConfirm',
        'data-autofocus': 'true',
      },
      'Cancel',
    ),
  );
}

function banners(state: UiState): ElementNode {
  const nameOf = (id: string | null): string | null => {
    const server = state.draft.find((candidate) => candidate.id === id);
    return server === undefined ? null : server.name.trim() === '' ? '(no name)' : server.name;
  };
  const errors = state.errors.map((error) => {
    const name = nameOf(error.serverId);
    return h('li', {}, name === null ? error.message : `${name}: ${error.message}`);
  });
  return h(
    'div',
    { class: 'banners' },
    state.problem === null
      ? null
      : h('div', { class: 'banner error', role: 'alert' }, state.problem),
    state.changedOnDisk
      ? h(
          'div',
          { class: 'banner warning', role: 'alert' },
          h('span', {}, 'The configuration was changed on disk outside this panel.'),
          h('button', { type: 'button', 'data-action': 'reload' }, 'Reload'),
        )
      : null,
    errors.length === 0
      ? null
      : h(
          'div',
          { class: 'banner error', role: 'alert' },
          h('span', {}, 'The configuration was not saved:'),
          h('ul', {}, ...errors),
        ),
    state.notice === null
      ? null
      : h('div', { class: 'banner notice', role: 'status' }, state.notice),
    confirmBar(state),
  );
}

function footer(state: UiState): ElementNode {
  const dirty = isDirty(state);
  return h(
    'footer',
    { class: 'actions' },
    h(
      'button',
      { type: 'button', 'data-action': 'save', disabled: state.problem !== null || state.saving },
      'Save',
    ),
    h(
      'button',
      { type: 'button', class: 'secondary', 'data-action': 'cancel', disabled: !dirty },
      'Cancel',
    ),
    dirty ? h('span', { class: 'hint' }, 'Unsaved changes') : null,
  );
}

/** The whole page for `state`. */
export function renderApp(state: UiState): ElementNode {
  if (!state.loaded) {
    return h('div', { class: 'app' }, h('p', { class: 'hint' }, 'Loading…'));
  }
  const server = selectedServer(state);
  let form: ElementNode;
  if (state.problem !== null) {
    form = h('div', { class: 'form' });
  } else if (server === undefined) {
    form = h('div', { class: 'form' }, h('p', { class: 'hint' }, 'Add a server with +.'));
  } else {
    form = server.type === 'sftp' ? sftpForm(state, server) : inplaceForm(state, server);
  }
  return h(
    'div',
    { class: 'app' },
    h('h1', {}, `Deployment: ${state.folderName}`),
    banners(state),
    h('div', { class: 'layout' }, state.problem === null ? serverList(state) : null, form),
    footer(state),
  );
}

/** Only the server list, re-rendered while typing so that the focused input stays. */
export function renderServerList(state: UiState): ElementNode {
  return serverList(state);
}
