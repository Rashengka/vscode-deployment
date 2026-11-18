/**
 * Test Connection with settings that are not saved yet. It runs the same flow as the command,
 * but on a connection of its own (the server's key with a suffix) that is always closed
 * afterwards: an open connection of the saved server is neither replaced by the unsaved
 * settings nor closed, and no connection with unsaved settings stays open (nor a report that
 * the configuration changed while it was open).
 */
import type { ConnectionManager } from '../ssh/connectionManager';
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
