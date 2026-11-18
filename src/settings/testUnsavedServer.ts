/**
 * Operations on a server with settings that are not saved yet (Test Connection, Autodetect,
 * Verify Mapping, the remote folder picker). They run on a connection of their own (the
 * server's key with a suffix) that is always closed afterwards: an open connection of the
 * saved server is neither replaced by the unsaved settings nor closed, and no connection with
 * unsaved settings stays open (nor a report that the configuration changed while it was open).
 *
 * The settings panel runs at most one of them at a time, so they can share that key.
 */
import { ConnectionError, type ConnectionManager } from '../ssh/connectionManager';
import type { DeploymentTarget } from '../transport/deploymentTarget';
import { testConnectionKey, type SftpServerChoice } from '../ui/serverChoices';
import {
  runTestConnection,
  type TestConnectionHost,
  type TestConnectionResult,
} from '../ui/testConnectionFlow';

export interface UnsavedTestHost extends TestConnectionHost {
  readonly connections: TestConnectionHost['connections'] & Pick<ConnectionManager, 'discard'>;
}

export async function testUnsavedServer(
  host: UnsavedTestHost,
  choice: SftpServerChoice,
): Promise<TestConnectionResult | undefined> {
  const key = testConnectionKey(choice.key);
  try {
    return await runTestConnection(host, { ...choice, key });
  } finally {
    host.connections.discard(key);
  }
}

type SessionConnections = Pick<ConnectionManager, 'run' | 'discard'>;

/** The server and its connection key; `configFile` is watched while connected, when known. */
export interface UnsavedServer {
  readonly key: string;
  readonly server: SftpServerChoice['server'];
  readonly configFile: string | undefined;
}

/**
 * Several operations on one connection with unsaved settings (the remote folder picker lists
 * folder after folder without asking for the passphrase again). {@link close} closes it; after
 * that, operations fail.
 */
export class UnsavedServerSession {
  private readonly connections: SessionConnections;
  private readonly choice: UnsavedServer;
  private readonly key: string;
  private closed = false;

  constructor(connections: SessionConnections, choice: UnsavedServer) {
    this.connections = connections;
    this.choice = choice;
    this.key = testConnectionKey(choice.key);
  }

  run<T>(operation: (target: DeploymentTarget) => Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(
        new ConnectionError(`The connection to ${this.choice.server.name} was closed.`),
      );
    }
    const { server, configFile } = this.choice;
    return this.connections.run({ server, configFile, key: this.key }, (target) =>
      operation(target),
    );
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.connections.discard(this.key);
    }
  }
}
