/**
 * Rendering of the settings webview as a plain tree of elements and text, without the DOM.
 *
 * Every value that comes from the configuration, the SSH config or a server (names, hosts,
 * paths, messages) is a text child here, and `dom.ts` turns text children into text nodes only:
 * no value is ever parsed as HTML. Elements carry no event handlers; `main.ts` handles events by
 * delegation, using the `data-action` and `data-field` attributes.
 */
import type { InplaceDraft, ListName, ServerDraft, SftpDraft } from '../settings/draft';
import {
  MAX_REMOTE_DEPTH,
  MAX_REMOTE_ENTRIES,
  type BrowsePurpose,
  type FormError,
  type RemoteEntryView,
} from '../settings/protocol';
import {
  ALIAS_PREFIX,
  MANUAL_VALUE,
  canChoose,
  isDirty,
  listFieldName,
  pickerValue,
  selectedServer,
  taskKey,
  type PickerState,
  type Tab,
  type UiState,
} from './state';

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
  /** Buttons after the input (for example a picker). */
  readonly button?: ElementNode | readonly ElementNode[];
}

function buttonList(button: ElementNode | readonly ElementNode[]): readonly ElementNode[] {
  return 'tag' in button ? [button] : button;
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
      : h('div', { class: 'with-button' }, input, ...buttonList(options.button)),
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

/** Aliases in alphabetical order, ignoring case; equal names keep the order of the SSH config. */
export function sortedAliases(aliases: readonly string[]): string[] {
  return aliases
    .map((alias) => ({ alias, key: alias.toLowerCase() }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((entry) => entry.alias);
}

function connectionSelect(state: UiState, server: SftpDraft): ElementNode {
  const manual = server.mode === 'manual';
  const selectedAlias = manual ? null : server.sshConfigHost;
  const known = state.aliases.some((alias) => alias === selectedAlias);
  // Manual… comes first so that it can be found in a long list of aliases. The placeholder of
  // a server without a connection is only the shown value, never an entry of the list.
  const options: ElementNode[] = [
    selectedAlias === ''
      ? h(
          'option',
          { value: '', selected: true, disabled: true, hidden: true },
          'Choose an SSH config host…',
        )
      : null,
    h('option', { value: MANUAL_VALUE, selected: manual }, 'Manual…'),
    ...sortedAliases(state.aliases).map((alias) =>
      h('option', { value: `${ALIAS_PREFIX}${alias}`, selected: alias === selectedAlias }, alias),
    ),
  ].filter((option): option is ElementNode => option !== null);
  if (!manual && selectedAlias !== null && selectedAlias !== '' && !known) {
    options.push(
      h(
        'option',
        { value: `${ALIAS_PREFIX}${selectedAlias}`, selected: true },
        `${selectedAlias} (not found in the SSH config)`,
      ),
    );
  }
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

/** Whether a server operation is running or the picker is open (the host runs one at a time). */
function serverBusy(state: UiState): boolean {
  return (
    state.picker !== null ||
    Object.values(state.tests).some((test) => test.state === 'running') ||
    [...state.tasks.values()].some((task) => task.state === 'running')
  );
}

function statusLine(status: { state: string; text: string } | undefined): ElementNode | null {
  return status === undefined
    ? null
    : h('span', { class: `test-status ${status.state}`, role: 'status' }, status.text);
}

function testConnection(state: UiState, server: SftpDraft): ElementNode {
  const status = state.tests[server.id];
  const running = serverBusy(state);
  return h(
    'div',
    { class: 'field test' },
    h(
      'button',
      { type: 'button', class: 'secondary', 'data-action': 'test', disabled: running },
      'Test Connection',
    ),
    statusLine(status),
  );
}

const TABS: readonly { readonly tab: Tab; readonly label: string }[] = [
  { tab: 'connection', label: 'Connection' },
  { tab: 'mappings', label: 'Mappings' },
  { tab: 'excluded', label: 'Excluded Paths' },
];

function tabBar(state: UiState, server: SftpDraft): ElementNode {
  const listsWithErrors = (tab: Tab): boolean =>
    state.errors.some((error) => {
      if (error.serverId !== server.id) {
        return false;
      }
      const field = error.field ?? '';
      const inMappings = field.startsWith('mappings.');
      const inExcluded = field.startsWith('excluded');
      if (tab === 'mappings') {
        return inMappings;
      }
      return tab === 'excluded' ? inExcluded : !inMappings && !inExcluded;
    });
  return h(
    'div',
    { class: 'tabs', role: 'tablist', 'aria-label': 'Server settings' },
    ...TABS.map(({ tab, label }) =>
      h(
        'button',
        {
          type: 'button',
          id: `tab-${tab}`,
          role: 'tab',
          class: `tab${state.tab === tab ? ' selected' : ''}`,
          'aria-selected': state.tab === tab ? 'true' : 'false',
          'data-action': 'tab',
          'data-tab': tab,
        },
        label,
        listsWithErrors(tab)
          ? h('span', { class: 'server-invalid', title: 'Has errors' }, ' !')
          : null,
      ),
    ),
  );
}

function sftpForm(state: UiState, server: SftpDraft): ElementNode {
  let panel: ElementNode;
  if (state.tab === 'mappings') {
    panel = mappingsTab(state, server);
  } else if (state.tab === 'excluded') {
    panel = excludedTab(state, server);
  } else {
    panel = connectionTab(state, server);
  }
  return h('section', { class: 'form', 'aria-label': 'SFTP server' }, tabBar(state, server), panel);
}

function rootPathField(state: UiState, server: SftpDraft): ElementNode {
  const busy = serverBusy(state);
  return h(
    'div',
    {},
    textField(state, server, {
      label: 'Root path',
      field: 'rootPath',
      value: server.rootPath,
      placeholder: '/home/deploy',
      hint: 'Absolute path on the server; deployment paths of the mappings are relative to it.',
      button: [
        h(
          'button',
          {
            type: 'button',
            class: 'secondary',
            'data-action': 'browseRemote',
            'data-purpose': 'rootPath',
            'data-index': '0',
            disabled: busy,
          },
          'Browse…',
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'secondary',
            'data-action': 'autodetect',
            title: 'Use the home directory of the user on the server',
            disabled: busy,
          },
          'Autodetect',
        ),
      ],
    }),
    statusLine(state.tasks.get(taskKey(server.id, 'autodetect'))),
  );
}

function connectionTab(state: UiState, server: SftpDraft): ElementNode {
  const alias = server.mode === 'alias';
  const fromConfig = alias ? 'From the SSH config' : undefined;
  return h(
    'div',
    { class: 'tab-panel', role: 'tabpanel', 'aria-labelledby': 'tab-connection' },
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
    rootPathField(state, server),
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

interface ListInputOptions {
  readonly list: ListName;
  readonly index: number;
  /** The column of a mapping; `null` for an excluded path. */
  readonly key: 'localPath' | 'deploymentPath' | null;
  readonly value: string;
  readonly label: string;
  readonly placeholder: string;
  readonly button: ElementNode;
}

function listInput(state: UiState, server: SftpDraft, options: ListInputOptions): ElementNode {
  const field = listFieldName(options.list, options.index, options.key);
  const id = `field-${field.replaceAll('.', '-')}`;
  const invalid = hasError(state.errors, server.id, field);
  return h(
    'div',
    { class: 'cell' },
    h('label', { for: id, class: 'visually-hidden' }, options.label),
    h(
      'div',
      { class: 'with-button' },
      h('input', {
        type: 'text',
        id,
        value: options.value,
        placeholder: options.placeholder,
        spellcheck: 'false',
        autocomplete: 'off',
        'data-field': field,
        'data-list': options.list,
        'data-index': String(options.index),
        'data-key': options.key ?? undefined,
        'aria-invalid': invalid ? 'true' : undefined,
        'aria-describedby': invalid ? `error-${field}` : undefined,
      }),
      options.button,
    ),
    fieldError(state.errors, server.id, field),
  );
}

function pickLocalButton(list: 'mappings' | 'excludedLocalPaths', index: number): ElementNode {
  return h(
    'button',
    {
      type: 'button',
      class: 'secondary',
      'data-action': 'pickLocal',
      'data-list': list,
      'data-index': String(index),
    },
    'Browse…',
  );
}

function browseRemoteButton(state: UiState, purpose: BrowsePurpose, index: number): ElementNode {
  return h(
    'button',
    {
      type: 'button',
      class: 'secondary',
      'data-action': 'browseRemote',
      'data-purpose': purpose,
      'data-index': String(index),
      disabled: serverBusy(state),
    },
    'Browse…',
  );
}

function removeButton(list: ListName, index: number, what: string): ElementNode {
  return h(
    'button',
    {
      type: 'button',
      class: 'icon',
      'data-action': 'removeItem',
      'data-list': list,
      'data-index': String(index),
      title: `Remove ${what}`,
      'aria-label': `Remove ${what}`,
    },
    '−',
  );
}

function verifyResults(state: UiState, server: SftpDraft): ElementNode | null {
  const result = state.verify.get(server.id);
  if (result === undefined) {
    return null;
  }
  return h(
    'div',
    { class: 'verify-results' },
    h(
      'p',
      { class: 'hint' },
      result.source === 'git'
        ? 'Sampled from the files tracked by git.'
        : 'Sampled from the workspace files (git was not available or listed no files).',
    ),
    result.truncated
      ? h(
          'p',
          { class: 'hint warning' },
          'The project has more files than were listed; the sample comes from the first ones.',
        )
      : null,
    h(
      'ul',
      { class: 'verify-list' },
      ...result.checks.map((check) =>
        h(
          'li',
          { class: `verify ${check.verdict}` },
          h(
            'div',
            {},
            h(
              'span',
              { class: 'verify-mapping' },
              `${check.localPath} → ${check.deploymentPath}: `,
            ),
            h('span', { class: 'verify-text' }, check.text),
          ),
          check.missing.length === 0
            ? null
            : h(
                'details',
                {},
                h('summary', {}, `Not found (${check.missing.length})`),
                h('ul', { class: 'missing' }, ...check.missing.map((file) => h('li', {}, file))),
              ),
          check.unchecked.length === 0
            ? null
            : h(
                'details',
                {},
                h('summary', {}, `Could not be checked (${check.unchecked.length})`),
                h(
                  'ul',
                  { class: 'missing' },
                  ...check.unchecked.map((file) => h('li', {}, `${file.path}: ${file.reason}`)),
                ),
              ),
        ),
      ),
    ),
  );
}

function mappingsTab(state: UiState, server: SftpDraft): ElementNode {
  const root = server.rootPath.trim() === '' ? '(not set)' : server.rootPath.trim();
  const rows = server.mappings.map((mapping, index) =>
    h(
      'div',
      { class: 'list-row mapping-row' },
      listInput(state, server, {
        list: 'mappings',
        index,
        key: 'localPath',
        value: mapping.localPath,
        label: `Mapping ${index + 1}, local path`,
        placeholder: '.',
        button: pickLocalButton('mappings', index),
      }),
      listInput(state, server, {
        list: 'mappings',
        index,
        key: 'deploymentPath',
        value: mapping.deploymentPath,
        label: `Mapping ${index + 1}, deployment path`,
        placeholder: 'www/app.example.com',
        button: browseRemoteButton(state, 'mapping', index),
      }),
      removeButton('mappings', index, `mapping ${index + 1}`),
    ),
  );
  return h(
    'div',
    { class: 'tab-panel', role: 'tabpanel', 'aria-labelledby': 'tab-mappings' },
    h(
      'p',
      { class: 'hint' },
      `Local path is relative to the project. Deployment path is relative to the server root path (${root}).`,
    ),
    rows.length === 0
      ? h('p', { class: 'hint empty' }, 'No mappings yet.')
      : h(
          'div',
          { class: 'list' },
          h(
            'div',
            { class: 'list-row list-head', 'aria-hidden': 'true' },
            h('span', { class: 'cell' }, 'Local path'),
            h('span', { class: 'cell' }, 'Deployment path'),
          ),
          ...rows,
        ),
    h(
      'div',
      { class: 'field buttons' },
      h(
        'button',
        { type: 'button', class: 'secondary', 'data-action': 'addItem', 'data-list': 'mappings' },
        'Add New Mapping',
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'secondary',
          'data-action': 'verify',
          disabled: serverBusy(state) || server.mappings.length === 0,
        },
        'Verify Mapping',
      ),
      statusLine(state.tasks.get(taskKey(server.id, 'verify'))),
    ),
    verifyResults(state, server),
  );
}

function excludedList(
  state: UiState,
  server: SftpDraft,
  list: 'excludedLocalPaths' | 'excludedRemotePaths',
): ElementNode {
  const local = list === 'excludedLocalPaths';
  const rows = server[list].map((value, index) =>
    h(
      'div',
      { class: 'list-row' },
      listInput(state, server, {
        list,
        index,
        key: null,
        value,
        label: `${local ? 'Local' : 'Remote'} excluded path ${index + 1}`,
        placeholder: local ? 'node_modules' : 'cache',
        button: local
          ? pickLocalButton('excludedLocalPaths', index)
          : browseRemoteButton(state, 'excludedRemote', index),
      }),
      removeButton(list, index, `excluded path ${index + 1}`),
    ),
  );
  return h(
    'div',
    { class: 'field' },
    h('h2', {}, local ? 'Local excluded paths' : 'Remote excluded paths'),
    h(
      'p',
      { class: 'hint' },
      local
        ? 'Relative to the project. Files there are never uploaded.'
        : 'Relative to the server root path. Nothing is uploaded there.',
    ),
    rows.length === 0 ? null : h('div', { class: 'list' }, ...rows),
    h(
      'button',
      { type: 'button', class: 'secondary', 'data-action': 'addItem', 'data-list': list },
      local ? 'Add Local Path' : 'Add Remote Path',
    ),
  );
}

function excludedTab(state: UiState, server: SftpDraft): ElementNode {
  return h(
    'div',
    { class: 'tab-panel', role: 'tabpanel', 'aria-labelledby': 'tab-excluded' },
    excludedList(state, server, 'excludedLocalPaths'),
    excludedList(state, server, 'excludedRemotePaths'),
  );
}

const PICKER_TITLES: Readonly<Record<BrowsePurpose, string>> = {
  rootPath: 'Select the root path on the server',
  mapping: 'Select the deployment path',
  excludedRemote: 'Select the path to exclude on the server',
};

function childPath(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`;
}

function matchesFilter(entry: RemoteEntryView, filter: string): boolean {
  return filter === '' || entry.label.toLowerCase().includes(filter.toLowerCase());
}

function pickerFolder(picker: PickerState, path: string, depth: number): ElementNode {
  const folder = picker.folders.get(path);
  if (folder === undefined || folder.loading) {
    return h('ul', { role: 'group' }, h('li', { class: 'hint' }, 'Loading…'));
  }
  if (folder.error !== null) {
    return h('ul', { role: 'group' }, h('li', { class: 'field-error' }, folder.error));
  }
  const filter = picker.filter.trim();
  const shown = folder.entries.filter(
    (entry) => matchesFilter(entry, filter) || picker.expanded.has(childPath(path, entry.name)),
  );
  const items = shown.map((entry) => pickerEntry(picker, path, entry, depth));
  return h(
    'ul',
    { role: 'group' },
    ...items,
    shown.length === 0 ? h('li', { class: 'hint' }, filter === '' ? '(empty)' : 'No match.') : null,
    folder.truncated
      ? h(
          'li',
          { class: 'hint warning' },
          `Only the first ${MAX_REMOTE_ENTRIES} entries are shown.`,
        )
      : null,
  );
}

function pickerEntry(
  picker: PickerState,
  parent: string,
  entry: RemoteEntryView,
  depth: number,
): ElementNode {
  const path = childPath(parent, entry.name);
  const opens = entry.usable && entry.kind === 'directory' && depth < MAX_REMOTE_DEPTH;
  const expanded = opens && picker.expanded.has(path);
  const choosable = entry.usable && canChoose(picker.purpose, entry.kind);
  const selected = choosable && picker.selected?.path === path;
  const suffix =
    entry.kind === 'symlink' ? ' (symbolic link)' : entry.usable ? '' : ' (unusable name)';
  const pathId = encodeURIComponent(path);
  return h(
    'li',
    { role: 'treeitem', 'aria-expanded': opens ? (expanded ? 'true' : 'false') : undefined },
    h(
      'div',
      { class: `tree-row kind-${entry.kind}` },
      opens
        ? h(
            'button',
            {
              type: 'button',
              id: `toggle-${pathId}`,
              class: 'icon toggle',
              'data-action': 'pickerToggle',
              'data-path': path,
              'aria-label': expanded ? 'Collapse' : 'Expand',
            },
            expanded ? '▾' : '▸',
          )
        : h('span', { class: 'toggle-space' }),
      h(
        'button',
        {
          type: 'button',
          id: `entry-${pathId}`,
          class: `entry${selected ? ' selected' : ''}`,
          'data-action': 'pickerSelect',
          'data-path': choosable ? path : undefined,
          'data-kind': entry.kind,
          'aria-pressed': selected ? 'true' : 'false',
          disabled: !choosable,
        },
        `${entry.label}${entry.kind === 'directory' ? '/' : ''}${suffix}`,
      ),
    ),
    expanded ? pickerFolder(picker, path, depth + 1) : null,
  );
}

function pickerDialog(picker: PickerState): ElementNode {
  const value = pickerValue(picker);
  const rootSelected = picker.selected?.path === '';
  const loaded = picker.session !== null;
  return h(
    'div',
    { class: 'modal-backdrop' },
    h(
      'div',
      {
        class: 'modal',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': PICKER_TITLES[picker.purpose],
      },
      h('h2', {}, PICKER_TITLES[picker.purpose]),
      picker.base === null
        ? h('p', { class: 'hint' }, 'Connecting… (the passphrase is asked for in VS Code)')
        : h('p', { class: 'hint' }, `Below ${picker.base}`),
      h('input', {
        type: 'text',
        id: 'picker-filter',
        value: picker.filter,
        placeholder: 'Filter',
        spellcheck: 'false',
        autocomplete: 'off',
        'aria-label': 'Filter',
        'data-picker': 'filter',
        'data-autofocus': picker.filter === '' && !loaded ? 'true' : undefined,
      }),
      picker.error === null
        ? null
        : h('div', { class: 'banner error', role: 'alert' }, picker.error),
      h(
        'div',
        { class: 'tree', role: 'tree', 'aria-label': 'Folders on the server' },
        loaded && picker.error === null && picker.purpose !== 'excludedRemote'
          ? h(
              'button',
              {
                type: 'button',
                id: 'entry-base',
                class: `entry base${rootSelected ? ' selected' : ''}`,
                'data-action': 'pickerSelect',
                'data-path': '',
                'data-kind': 'directory',
                'aria-pressed': rootSelected ? 'true' : 'false',
              },
              picker.base ?? '',
            )
          : null,
        // Without a connection the tree stops; only Cancel is left.
        picker.error === null ? pickerFolder(picker, '', 0) : null,
      ),
      h(
        'div',
        { class: 'actions' },
        h('button', { type: 'button', 'data-action': 'pickerOk', disabled: value === null }, 'OK'),
        h(
          'button',
          { type: 'button', class: 'secondary', 'data-action': 'pickerCancel' },
          'Cancel',
        ),
        value === null ? null : h('span', { class: 'hint' }, value),
      ),
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

/** The safe answer of a confirmation: first, the primary button, and focused (Enter). */
function cancelButton(): ElementNode {
  return h(
    'button',
    { type: 'button', 'data-action': 'cancelConfirm', 'data-autofocus': 'true' },
    'Cancel',
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
      cancelButton(),
      h('button', { type: 'button', class: 'secondary', 'data-action': 'confirmRemove' }, 'Remove'),
    );
  }
  return h(
    'div',
    { class: 'banner confirm', role: 'alertdialog', 'aria-label': 'Discard changes' },
    h('span', {}, 'Discard all unsaved changes?'),
    cancelButton(),
    h('button', { type: 'button', class: 'secondary', 'data-action': 'confirmDiscard' }, 'Discard'),
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
    state.warning === null
      ? null
      : h('div', { class: 'banner warning', role: 'alert' }, state.warning),
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
    state.picker === null ? null : pickerDialog(state.picker),
  );
}

/** Only the server list, re-rendered while typing so that the focused input stays. */
export function renderServerList(state: UiState): ElementNode {
  return serverList(state);
}
