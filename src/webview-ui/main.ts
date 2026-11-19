/**
 * Entry point of the settings webview (bundled to `dist/webview/main.js`). It keeps the form
 * state, renders it with `view.ts` and `dom.ts`, handles events by delegation (there are no
 * inline handlers; the Content Security Policy would block them) and talks to the extension
 * host only through messages. Saving, validation, dialogs and Test Connection happen in the
 * extension host.
 */
import type { HostMessage, WebviewMessage } from '../settings/protocol';
import { createNode } from './dom';
import {
  INITIAL_STATE,
  addServer,
  applyHostMessage,
  isDirty,
  pathFieldOf,
  removeServer,
  select,
  selectConnection,
  selectedServer,
  startSaving,
  toggleDefault,
  updateField,
  type UiState,
} from './state';
import { renderApp, renderServerList } from './view';

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();
const root = document.getElementById('app');
let state: UiState = INITIAL_STATE;

function post(message: WebviewMessage): void {
  api.postMessage(message);
}

function postDraft(): void {
  post({ type: 'draft', servers: state.draft });
}

/** 128 random bits as hex, for the id of a new server. */
function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function render(): void {
  if (root === null) {
    return;
  }
  const focusedId = document.activeElement instanceof HTMLElement ? document.activeElement.id : '';
  root.replaceChildren(createNode(document, renderApp(state)) as Node);
  const autofocus = root.querySelector<HTMLElement>('[data-autofocus="true"]');
  const previous = focusedId === '' ? null : document.getElementById(focusedId);
  (autofocus ?? previous)?.focus();
}

/** Re-renders only the server list, so that the input being typed into keeps its focus. */
function renderList(): void {
  const list = root?.querySelector('nav.servers');
  list?.replaceWith(createNode(document, renderServerList(state)) as Node);
}

function update(next: UiState, how: 'full' | 'list'): void {
  state = next;
  if (how === 'full') {
    render();
  } else {
    renderList();
  }
}

function onAction(action: string, element: HTMLElement): void {
  const server = selectedServer(state);
  switch (action) {
    case 'select':
      update(select(state, element.dataset['id'] ?? ''), 'full');
      return;
    case 'add':
      update({ ...state, addMenuOpen: !state.addMenuOpen, confirm: null }, 'full');
      return;
    case 'addType': {
      const type = element.dataset['type'];
      if (type === 'sftp' || type === 'inplace') {
        update(addServer(state, type, newId()), 'full');
        postDraft();
      }
      return;
    }
    case 'remove':
      if (server !== undefined) {
        update(
          { ...state, confirm: { kind: 'remove', id: server.id }, addMenuOpen: false },
          'full',
        );
      }
      return;
    case 'confirmRemove':
      if (state.confirm?.kind === 'remove') {
        update(removeServer(state, state.confirm.id), 'full');
        postDraft();
      }
      return;
    case 'cancelConfirm':
      update({ ...state, confirm: null }, 'full');
      return;
    case 'save':
      update(startSaving(state), 'full');
      post({ type: 'save', servers: state.draft });
      return;
    case 'cancel':
    case 'reload':
      if (isDirty(state)) {
        update({ ...state, confirm: { kind: 'discard' }, addMenuOpen: false }, 'full');
      } else {
        post({ type: 'reload' });
      }
      return;
    case 'confirmDiscard':
      post({ type: 'reload' });
      return;
    case 'pick':
      if (server !== undefined) {
        post({ type: 'pickPath', id: server.id, field: pathFieldOf(server) });
      }
      return;
    case 'test':
      if (server?.type === 'sftp') {
        post({ type: 'testConnection', server });
      }
      return;
    default:
  }
}

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const element = target?.closest<HTMLElement>('[data-action]');
  const action = element?.dataset['action'];
  if (element instanceof HTMLButtonElement && !element.disabled && action !== undefined) {
    onAction(action, element);
  }
});

document.addEventListener('input', (event) => {
  const input = event.target;
  const server = selectedServer(state);
  if (!(input instanceof HTMLInputElement) || input.type !== 'text' || server === undefined) {
    return;
  }
  const field = input.dataset['field'];
  if (field === undefined) {
    return;
  }
  update(updateField(state, server.id, field, input.value), 'list');
  // The error of this field no longer applies; the rest of the form stays as it is.
  document.getElementById(`error-${field}`)?.remove();
  input.removeAttribute('aria-invalid');
  postDraft();
});

document.addEventListener('change', (event) => {
  const target = event.target;
  const server = selectedServer(state);
  if (server === undefined) {
    return;
  }
  if (target instanceof HTMLSelectElement && target.dataset['field'] === 'connection') {
    update(selectConnection(state, server.id, target.value), 'full');
    postDraft();
  } else if (target instanceof HTMLInputElement && target.dataset['field'] === 'default') {
    update(toggleDefault(state, server.id, target.checked), 'full');
    postDraft();
  }
});

function isHostMessage(value: unknown): value is HostMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (isHostMessage(event.data)) {
    update(applyHostMessage(state, event.data), 'full');
  }
});

render();
post({ type: 'ready' });
