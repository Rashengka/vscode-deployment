/**
 * State of the settings webview and its transitions, without the DOM, so that it can be tested
 * on its own. `main.ts` keeps one {@link UiState}, applies these functions to it and renders the
 * result with `view.ts`.
 */
import {
  newMappingDraft,
  newServerDraft,
  sameDrafts,
  setDefault,
  type ListName,
  type ServerDraft,
  type ServerType,
  type SftpDraft,
} from '../settings/draft';
import type {
  BrowsePurpose,
  FormError,
  HostMessage,
  MappingCheckView,
  PathField,
  RemoteEntryView,
  RemoteKind,
  ServerTask,
  TestState,
} from '../settings/protocol';

export type Tab = 'connection' | 'mappings' | 'excluded';

export interface VerifyView {
  readonly source: 'git' | 'workspace';
  readonly truncated: boolean;
  readonly checks: readonly MappingCheckView[];
}

export interface PickerFolder {
  readonly loading: boolean;
  readonly entries: readonly RemoteEntryView[];
  readonly truncated: boolean;
  readonly error: string | null;
}

/** The remote folder picker. Paths are relative to its base folder; `""` is the base. */
export interface PickerState {
  readonly serverId: string;
  readonly purpose: BrowsePurpose;
  /** The row the result goes to. */
  readonly index: number;
  /** Set by the first listing; `null` while connecting. */
  readonly session: string | null;
  /** The base folder, as the host shows it. */
  readonly base: string | null;
  readonly folders: ReadonlyMap<string, PickerFolder>;
  readonly expanded: ReadonlySet<string>;
  readonly selected: { readonly path: string; readonly kind: RemoteKind } | null;
  readonly filter: string;
  /** Connecting failed, or the connection was lost. */
  readonly error: string | null;
}

export type Confirmation =
  { readonly kind: 'remove'; readonly id: string } | { readonly kind: 'discard' } | null;

export interface TestStatus {
  readonly state: TestState;
  readonly text: string;
}

export interface UiState {
  readonly loaded: boolean;
  readonly folderName: string;
  readonly saved: readonly ServerDraft[];
  readonly draft: readonly ServerDraft[];
  readonly aliases: readonly string[];
  readonly aliasProblem: string | null;
  readonly problem: string | null;
  readonly changedOnDisk: boolean;
  readonly notice: string | null;
  readonly errors: readonly FormError[];
  readonly selectedId: string | null;
  readonly addMenuOpen: boolean;
  readonly confirm: Confirmation;
  readonly tests: Readonly<Record<string, TestStatus>>;
  /** A Save was sent and the host has not answered yet. */
  readonly saving: boolean;
  readonly tab: Tab;
  /** Autodetect and Verify Mapping status, by `taskKey`. */
  readonly tasks: ReadonlyMap<string, TestStatus>;
  /** The last Verify Mapping result, by server id. */
  readonly verify: ReadonlyMap<string, VerifyView>;
  /** A warning that is not an error of the form (for example a path outside the project). */
  readonly warning: string | null;
  readonly picker: PickerState | null;
}

export function taskKey(id: string, task: ServerTask): string {
  return `${task}\n${id}`;
}

export const INITIAL_STATE: UiState = {
  loaded: false,
  folderName: '',
  saved: [],
  draft: [],
  aliases: [],
  aliasProblem: null,
  problem: null,
  changedOnDisk: false,
  notice: null,
  errors: [],
  selectedId: null,
  addMenuOpen: false,
  confirm: null,
  tests: {},
  saving: false,
  tab: 'connection',
  tasks: new Map(),
  verify: new Map(),
  warning: null,
  picker: null,
};

/** Save was clicked; Save stays disabled until the host answers. */
export function startSaving(state: UiState): UiState {
  return { ...state, saving: true };
}

export function isDirty(state: UiState): boolean {
  return !sameDrafts(state.draft, state.saved);
}

export function selectedServer(state: UiState): ServerDraft | undefined {
  return state.draft.find((server) => server.id === state.selectedId);
}

function keepSelection(selectedId: string | null, servers: readonly ServerDraft[]): string | null {
  if (servers.some((server) => server.id === selectedId)) {
    return selectedId;
  }
  return servers[0]?.id ?? null;
}

/** Applies a message from the extension host. */
export function applyHostMessage(state: UiState, message: HostMessage): UiState {
  switch (message.type) {
    case 'state':
      return {
        ...state,
        loaded: true,
        folderName: message.folderName,
        saved: message.saved,
        draft: message.draft,
        aliases: message.aliases,
        aliasProblem: message.aliasProblem,
        problem: message.problem,
        changedOnDisk: message.changedOnDisk,
        notice: message.notice,
        errors: message.errors,
        selectedId: keepSelection(state.selectedId, message.draft),
        confirm: null,
        addMenuOpen: false,
        saving: false,
        warning: null,
        ...forgetStale(state, message.draft),
      };
    case 'changedOnDisk':
      return { ...state, changedOnDisk: true, notice: null, saving: false };
    case 'errors':
      return { ...state, errors: message.errors, notice: null, saving: false };
    case 'saveFailed':
      return {
        ...state,
        errors: [{ serverId: null, field: null, message: message.message }],
        notice: null,
        saving: false,
      };
    case 'saved':
      return { ...state, saved: state.draft, errors: [], notice: 'Saved.', saving: false };
    case 'picked':
      return updateField(state, message.id, message.field, message.path);
    case 'testStatus':
      return {
        ...state,
        tests: { ...state.tests, [message.id]: { state: message.state, text: message.text } },
      };
    case 'pickedItem':
      return updateListItem(
        state,
        message.id,
        message.list,
        message.index,
        message.list === 'mappings' ? 'localPath' : null,
        message.path,
      );
    case 'problem':
      return { ...state, warning: message.message };
    case 'taskStatus': {
      const tasks = new Map(state.tasks);
      tasks.set(taskKey(message.id, message.task), { state: message.state, text: message.text });
      return { ...state, tasks };
    }
    case 'verifyResult': {
      const verify = new Map(state.verify);
      verify.set(message.id, {
        source: message.source,
        truncated: message.truncated,
        checks: message.checks,
      });
      return { ...state, verify };
    }
    case 'remoteListing':
      return applyListing(state, message);
    case 'remoteError':
      return applyRemoteError(state, message);
  }
}

/**
 * What a new state from the host makes stale: an operation shown as running (the host answers
 * every operation, so one that is still shown running would only keep the buttons disabled),
 * and the results and the picker of servers that are no longer in the form.
 */
function forgetStale(
  state: UiState,
  draft: readonly ServerDraft[],
): Pick<UiState, 'tests' | 'tasks' | 'verify' | 'picker'> {
  const ids = new Set(draft.map((server) => server.id));
  const tests: Record<string, TestStatus> = {};
  for (const [id, status] of Object.entries(state.tests)) {
    if (status.state !== 'running') {
      tests[id] = status;
    }
  }
  return {
    tests,
    tasks: new Map([...state.tasks].filter(([, status]) => status.state !== 'running')),
    verify: new Map([...state.verify].filter(([id]) => ids.has(id))),
    picker: state.picker !== null && ids.has(state.picker.serverId) ? state.picker : null,
  };
}

function applyListing(
  state: UiState,
  message: Extract<HostMessage, { type: 'remoteListing' }>,
): UiState {
  const { picker } = state;
  if (picker === null || (picker.session !== null && picker.session !== message.session)) {
    return state;
  }
  const folders = new Map(picker.folders);
  folders.set(message.path, {
    loading: false,
    entries: message.entries,
    truncated: message.truncated,
    error: null,
  });
  return {
    ...state,
    picker: { ...picker, session: message.session, base: message.base, folders, error: null },
  };
}

function applyRemoteError(
  state: UiState,
  message: Extract<HostMessage, { type: 'remoteError' }>,
): UiState {
  const { picker } = state;
  if (picker === null) {
    return state;
  }
  if (message.session === null) {
    const folders = new Map(
      [...picker.folders].map(([path, folder]) => [path, { ...folder, loading: false }] as const),
    );
    return { ...state, picker: { ...picker, folders, error: message.message } };
  }
  if (message.session !== picker.session) {
    return state;
  }
  const folders = new Map(picker.folders);
  folders.set(message.path, {
    loading: false,
    entries: [],
    truncated: false,
    error: message.message,
  });
  return { ...state, picker: { ...picker, folders } };
}

export function selectTab(state: UiState, tab: Tab): UiState {
  return { ...state, tab, confirm: null, addMenuOpen: false };
}

function updateSftp(state: UiState, id: string, change: (server: SftpDraft) => SftpDraft): UiState {
  const draft = state.draft.map((server) =>
    server.id === id && server.type === 'sftp' ? change(server) : server,
  );
  return { ...state, draft, notice: null, warning: null };
}

/** The error field of a row of a list (as `save.ts` reports it). */
export function listFieldName(list: ListName, index: number, key: string | null): string {
  return key === null ? `${list}.${index}` : `${list}.${index}.${key}`;
}

/** Sets a row of a list; `key` is the column of a mapping, `null` for the excluded paths. */
export function updateListItem(
  state: UiState,
  id: string,
  list: ListName,
  index: number,
  key: string | null,
  value: string,
): UiState {
  const next = updateSftp(state, id, (server) => {
    if (list === 'mappings') {
      const row = server.mappings[index];
      if (row === undefined || (key !== 'localPath' && key !== 'deploymentPath')) {
        return server;
      }
      return { ...server, mappings: server.mappings.with(index, { ...row, [key]: value }) };
    }
    const rows = server[list];
    if (index >= rows.length || key !== null) {
      return server;
    }
    return { ...server, [list]: rows.with(index, value) };
  });
  return { ...next, errors: withoutError(state.errors, id, listFieldName(list, index, key)) };
}

export function addListItem(state: UiState, id: string, list: ListName): UiState {
  return updateSftp(state, id, (server) =>
    list === 'mappings'
      ? { ...server, mappings: [...server.mappings, newMappingDraft()] }
      : { ...server, [list]: [...server[list], ''] },
  );
}

/** Removes a row; the errors of that list no longer match their rows, so they are cleared. */
export function removeListItem(state: UiState, id: string, list: ListName, index: number): UiState {
  const next = updateSftp(state, id, (server) =>
    list === 'mappings'
      ? { ...server, mappings: server.mappings.filter((_row, i) => i !== index) }
      : { ...server, [list]: server[list].filter((_row, i) => i !== index) },
  );
  const errors = state.errors.filter(
    (error) => !(error.serverId === id && error.field?.startsWith(`${list}.`) === true),
  );
  return { ...next, errors };
}

export function isListName(value: string | undefined): value is ListName {
  return value === 'mappings' || value === 'excludedLocalPaths' || value === 'excludedRemotePaths';
}

export function isBrowsePurpose(value: string | undefined): value is BrowsePurpose {
  return value === 'rootPath' || value === 'mapping' || value === 'excludedRemote';
}

/** Opens the remote folder picker (it connects; the first listing arrives later). */
export function openPicker(
  state: UiState,
  serverId: string,
  purpose: BrowsePurpose,
  index: number,
): UiState {
  const loading: PickerFolder = { loading: true, entries: [], truncated: false, error: null };
  return {
    ...state,
    picker: {
      serverId,
      purpose,
      index,
      session: null,
      base: null,
      folders: new Map([['', loading]]),
      expanded: new Set(['']),
      selected: null,
      filter: '',
      error: null,
    },
  };
}

export function closePicker(state: UiState): UiState {
  return { ...state, picker: null };
}

/** Opens or closes a folder; `list` is true when its entries have to be requested. */
export function togglePickerFolder(
  state: UiState,
  path: string,
): { readonly state: UiState; readonly list: boolean } {
  const { picker } = state;
  if (picker === null || picker.error !== null) {
    // Without a connection nothing can be listed.
    return { state, list: false };
  }
  const expanded = new Set(picker.expanded);
  if (expanded.has(path)) {
    expanded.delete(path);
    return { state: { ...state, picker: { ...picker, expanded } }, list: false };
  }
  expanded.add(path);
  const known = picker.folders.get(path);
  const list = known === undefined || (known.error !== null && !known.loading);
  const folders = new Map(picker.folders);
  if (list) {
    folders.set(path, { loading: true, entries: [], truncated: false, error: null });
  }
  return { state: { ...state, picker: { ...picker, expanded, folders } }, list };
}

/** Whether an entry of `kind` can be the result of the picker for `purpose`. */
export function canChoose(purpose: BrowsePurpose, kind: RemoteKind): boolean {
  if (kind === 'directory') {
    return true;
  }
  return purpose === 'excludedRemote' && (kind === 'file' || kind === 'symlink');
}

export function selectPickerEntry(state: UiState, path: string, kind: RemoteKind): UiState {
  const { picker } = state;
  if (picker === null || !canChoose(picker.purpose, kind)) {
    return state;
  }
  return { ...state, picker: { ...picker, selected: { path, kind } } };
}

export function setPickerFilter(state: UiState, filter: string): UiState {
  return state.picker === null ? state : { ...state, picker: { ...state.picker, filter } };
}

/** The value the picker's selection gives, or `null` when it cannot be chosen. */
export function pickerValue(picker: PickerState): string | null {
  const { selected } = picker;
  if (selected === null || picker.session === null || picker.error !== null) {
    return null;
  }
  switch (picker.purpose) {
    case 'rootPath':
      // The base of this picker is the server's root folder.
      return `/${selected.path}`;
    case 'mapping':
      return selected.path === '' ? '.' : selected.path;
    case 'excludedRemote':
      return selected.path === '' ? null : selected.path;
  }
}

/** OK in the picker: puts the selection into the form and closes the picker. */
export function confirmPicker(state: UiState): UiState {
  const { picker } = state;
  const value = picker === null ? null : pickerValue(picker);
  if (picker === null || value === null) {
    return state;
  }
  const closed = closePicker(state);
  switch (picker.purpose) {
    case 'rootPath':
      return updateField(closed, picker.serverId, 'rootPath', value);
    case 'mapping':
      return updateListItem(
        closed,
        picker.serverId,
        'mappings',
        picker.index,
        'deploymentPath',
        value,
      );
    case 'excludedRemote':
      return updateListItem(
        closed,
        picker.serverId,
        'excludedRemotePaths',
        picker.index,
        null,
        value,
      );
  }
}

/** Sets a text field of a server; unknown fields and fields of the other type are ignored. */
export function updateField(state: UiState, id: string, field: string, value: string): UiState {
  const draft = state.draft.map((server) => {
    if (server.id !== id || !Object.hasOwn(server, field) || isFixedField(field)) {
      return server;
    }
    return { ...server, [field]: value };
  });
  return {
    ...state,
    draft,
    notice: null,
    warning: null,
    errors: withoutError(state.errors, id, field),
  };
}

/** Fields that are not free text. */
function isFixedField(field: string): boolean {
  return (
    field === 'id' ||
    field === 'type' ||
    field === 'default' ||
    field === 'mode' ||
    isListName(field)
  );
}

function withoutError(errors: readonly FormError[], id: string, field: string): FormError[] {
  return errors.filter((error) => !(error.serverId === id && error.field === field));
}

/** The connection dropdown: an alias, or the manual connection. */
export function selectConnection(state: UiState, id: string, value: string): UiState {
  const draft = state.draft.map((server) => {
    if (server.id !== id || server.type !== 'sftp') {
      return server;
    }
    return value === MANUAL_VALUE
      ? { ...server, mode: 'manual' as const }
      : {
          ...server,
          mode: 'alias' as const,
          sshConfigHost: value.startsWith(ALIAS_PREFIX) ? value.slice(ALIAS_PREFIX.length) : '',
        };
  });
  const errors = withoutError(withoutError(state.errors, id, 'sshConfigHost'), id, 'host');
  return { ...state, draft, notice: null, errors };
}

/** Values of the connection dropdown. */
export const MANUAL_VALUE = 'manual';
export const ALIAS_PREFIX = 'alias:';

export function toggleDefault(state: UiState, id: string, value: boolean): UiState {
  return { ...state, draft: setDefault(state.draft, id, value), notice: null };
}

export function addServer(state: UiState, type: ServerType, id: string): UiState {
  const server = newServerDraft(type, id, state.draft);
  return {
    ...state,
    draft: [...state.draft, server],
    selectedId: id,
    addMenuOpen: false,
    notice: null,
  };
}

/** Removes a server from the form (the file changes on Save). */
export function removeServer(state: UiState, id: string): UiState {
  const index = state.draft.findIndex((server) => server.id === id);
  const draft = state.draft.filter((server) => server.id !== id);
  const next = draft[Math.min(index, draft.length - 1)]?.id ?? null;
  return {
    ...state,
    draft,
    selectedId: state.selectedId === id ? next : state.selectedId,
    confirm: null,
    notice: null,
    errors: state.errors.filter((error) => error.serverId !== id),
  };
}

export function select(state: UiState, id: string): UiState {
  return state.draft.some((server) => server.id === id)
    ? { ...state, selectedId: id, confirm: null, addMenuOpen: false }
    : state;
}

export function pathFieldOf(server: ServerDraft): PathField {
  return server.type === 'sftp' ? 'identityFile' : 'folder';
}
