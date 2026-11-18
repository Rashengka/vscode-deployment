import { describe, expect, it } from 'vitest';
import {
  ConnectionStates,
  connectionMenuItems,
  describeDisconnect,
  statusBarPresentation,
} from '../../../src/ui/connectionPresentation';

function states(
  ...events: {
    serverId: string;
    serverName: string;
    status: 'connecting' | 'connected' | 'disconnected';
  }[]
): ConnectionStates {
  const tracked = new ConnectionStates();
  for (const event of events) {
    tracked.apply(event);
  }
  return tracked;
}

describe('ConnectionStates', () => {
  it('follows the events and forgets disconnected servers', () => {
    const tracked = states(
      { serverId: 'a', serverName: 'Production', status: 'connecting' },
      { serverId: 'b', serverName: 'Staging', status: 'connecting' },
      { serverId: 'a', serverName: 'Production', status: 'connected' },
      { serverId: 'b', serverName: 'Staging', status: 'disconnected' },
    );

    expect(tracked.list()).toEqual([
      { serverId: 'a', serverName: 'Production', status: 'connected' },
    ]);
    expect(tracked.anyActive()).toBe(true);
  });
});

describe('statusBarPresentation', () => {
  it('shows that nothing is connected', () => {
    expect(statusBarPresentation(states())).toEqual({
      text: '$(debug-disconnect) Disconnected',
      tooltip: 'Deployment: not connected',
    });
  });

  it('shows the connected server by name', () => {
    expect(
      statusBarPresentation(
        states({ serverId: 'a', serverName: 'Production', status: 'connected' }),
      ),
    ).toEqual({
      text: '$(plug) Production',
      tooltip: 'Deployment: connected to Production',
    });
  });

  it('shows a connection in progress', () => {
    expect(
      statusBarPresentation(
        states({ serverId: 'a', serverName: 'Production', status: 'connecting' }),
      ),
    ).toEqual({
      text: '$(sync~spin) Production',
      tooltip: 'Deployment: connecting to Production',
    });
  });

  it('counts several connections and lists them in the tooltip', () => {
    expect(
      statusBarPresentation(
        states(
          { serverId: 'a', serverName: 'Production', status: 'connected' },
          { serverId: 'b', serverName: 'Staging', status: 'connecting' },
        ),
      ),
    ).toEqual({
      text: '$(plug) 2 servers',
      tooltip: 'Deployment: connected to Production; connecting to Staging',
    });
  });

  it('never lets a server name inject icons or control characters', () => {
    const presentation = statusBarPresentation(
      states({ serverId: 'a', serverName: '$(alert) Prod\u001b‮', status: 'connected' }),
    );

    expect(presentation.text).toBe('$(plug) \\$(alert) Prod\\x1b\\u202e');
  });
});

describe('connectionMenuItems', () => {
  it('offers Disconnect for each server, Disconnect All for several and Test Connection', () => {
    const items = connectionMenuItems(
      states(
        { serverId: 'a', serverName: 'Production', status: 'connected' },
        { serverId: 'b', serverName: 'Staging', status: 'connecting' },
      ),
    );

    expect(items.map((item) => [item.label, item.action])).toEqual([
      ['$(debug-disconnect) Disconnect Production', { kind: 'disconnect', serverId: 'a' }],
      ['$(debug-disconnect) Disconnect Staging', { kind: 'disconnect', serverId: 'b' }],
      ['$(debug-disconnect) Disconnect All', { kind: 'disconnectAll' }],
      ['$(plug) Test Connection…', { kind: 'testConnection' }],
    ]);
  });

  it('offers only Test Connection when nothing is connected', () => {
    expect(connectionMenuItems(states()).map((item) => item.action)).toEqual([
      { kind: 'testConnection' },
    ]);
  });
});

describe('describeDisconnect', () => {
  it('explains why a connection was closed', () => {
    expect(describeDisconnect('requested')).toBe('disconnected');
    expect(describeDisconnect('idle')).toBe('disconnected after the idle time');
    expect(describeDisconnect('configurationChanged')).toBe(
      'disconnected because the configuration changed outside the extension',
    );
    expect(describeDisconnect('closed')).toBe('the connection was closed by the server or network');
    expect(describeDisconnect('failed')).toBe('connecting failed');
    expect(describeDisconnect(undefined)).toBe('disconnected');
  });
});
