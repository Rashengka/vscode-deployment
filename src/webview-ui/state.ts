/**
 * State of the settings webview and its transitions, without the DOM, so that it can be tested
 * on its own. `main.ts` keeps one {@link UiState}, applies these functions to it and renders the
 * result with `view.ts`.
 */
import {
  newServerDraft,
  sameDrafts,
  setDefault,
  type ServerDraft,
  type ServerType,
} from '../settings/draft';
import type { FormError, HostMessage, PathField, TestState } from '../settings/protocol';

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
  return { ...state, draft, notice: null, errors: withoutError(state.errors, id, field) };
}

/** Fields that are not free text. */
function isFixedField(field: string): boolean {
  return field === 'id' || field === 'type' || field === 'default' || field === 'mode';
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
