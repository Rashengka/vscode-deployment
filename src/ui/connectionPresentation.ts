/**
 * What the status bar and the connection menu show, derived from the connection events of the
 * `ConnectionManager`. Kept free of the VS Code API so that it can be tested on its own.
 */
import { sanitizeForDisplay } from '../display/sanitize';
import { isTestConnectionKey } from './serverChoices';
import type {
  ConnectionStateEvent,
  ConnectionStatus,
  DisconnectReason,
} from '../ssh/connectionManager';

export interface ActiveConnection {
  readonly serverId: string;
  readonly serverName: string;
  readonly status: Exclude<ConnectionStatus, 'disconnected'>;
}

/** The connections that are open or opening, in the order they started. */
export class ConnectionStates {
  private readonly active = new Map<string, ActiveConnection>();

  apply(event: Pick<ConnectionStateEvent, 'serverId' | 'serverName' | 'status'>): void {
    if (isTestConnectionKey(event.serverId)) {
      // A Test Connection with unsaved settings: closed right after the test.
      return;
    }
    if (event.status === 'disconnected') {
      this.active.delete(event.serverId);
      return;
    }
    this.active.set(event.serverId, {
      serverId: event.serverId,
      serverName: event.serverName,
      status: event.status,
    });
  }

  list(): ActiveConnection[] {
    return [...this.active.values()];
  }

  anyActive(): boolean {
    return this.active.size > 0;
  }
}

/** A server name for a label that renders `$(icon)` syntax: sanitized, icons escaped. */
export function labelText(name: string): string {
  return sanitizeForDisplay(name, { maxLength: 60 }).replace(/\$\(/g, '\\$(');
}

export interface StatusBarPresentation {
  readonly text: string;
  readonly tooltip: string;
}

function describeState(connection: ActiveConnection): string {
  const name = sanitizeForDisplay(connection.serverName, { maxLength: 60 });
  return connection.status === 'connected' ? `connected to ${name}` : `connecting to ${name}`;
}

export function statusBarPresentation(states: ConnectionStates): StatusBarPresentation {
  const active = states.list();
  const [only] = active;
  if (only === undefined) {
    return { text: '$(debug-disconnect) Disconnected', tooltip: 'Deployment: not connected' };
  }
  const tooltip = `Deployment: ${active.map(describeState).join('; ')}`;
  if (active.length === 1) {
    const icon = only.status === 'connected' ? '$(plug)' : '$(sync~spin)';
    return { text: `${icon} ${labelText(only.serverName)}`, tooltip };
  }
  const icon = active.some((connection) => connection.status === 'connected')
    ? '$(plug)'
    : '$(sync~spin)';
  return { text: `${icon} ${active.length} servers`, tooltip };
}

export type ConnectionMenuAction =
  | { readonly kind: 'disconnect'; readonly serverId: string }
  | { readonly kind: 'disconnectAll' }
  | { readonly kind: 'testConnection' };

export interface ConnectionMenuItem {
  readonly label: string;
  readonly description?: string;
  readonly action: ConnectionMenuAction;
}

export function connectionMenuItems(states: ConnectionStates): ConnectionMenuItem[] {
  const active = states.list();
  const items: ConnectionMenuItem[] = active.map((connection) => ({
    label: `$(debug-disconnect) Disconnect ${labelText(connection.serverName)}`,
    description: connection.status === 'connected' ? 'connected' : 'connecting',
    action: { kind: 'disconnect', serverId: connection.serverId },
  }));
  if (active.length > 1) {
    items.push({ label: '$(debug-disconnect) Disconnect All', action: { kind: 'disconnectAll' } });
  }
  items.push({ label: '$(plug) Test Connection…', action: { kind: 'testConnection' } });
  return items;
}

/** For the log: why a connection ended. */
export function describeDisconnect(reason: DisconnectReason | undefined): string {
  switch (reason) {
    case 'idle':
      return 'disconnected after the idle time';
    case 'configurationChanged':
      return 'disconnected because the configuration changed outside the extension';
    case 'reconfigured':
      return 'disconnected because the server settings changed';
    case 'closed':
      return 'the connection was closed by the server or network';
    case 'failed':
      return 'connecting failed';
    case 'disposed':
      return 'disconnected because the extension stopped';
    case 'requested':
    case undefined:
      return 'disconnected';
  }
}
