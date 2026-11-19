/** The servers Test Connection can be used with. Kept free of the VS Code API. */
import { posix, win32 } from 'node:path';
import type { FoldersSnapshot } from '../config/folders';
import { CONFIG_FILE_NAME, type SftpServer } from '../config/model';

export interface SftpServerChoice {
  /**
   * The connection key: workspace folder and server id (ids are unique within one config.json
   * only).
   */
  readonly key: string;
  readonly server: SftpServer;
  readonly folderName: string;
  /** The config.json the server comes from (watched while connected). */
  readonly configFile: string;
}

/** The connection key of a server of a workspace folder (`folderKey` is the folder URI). */
export function connectionKey(folderKey: string, serverId: string): string {
  return `${folderKey}\n${serverId}`;
}

/** Suffix of the keys Test Connection uses for unsaved settings; no server id contains it. */
const TEST_KEY_SUFFIX = '\ntest';

/** The key of the separate connection that tests unsaved settings of the server `key`. */
export function testConnectionKey(key: string): string {
  return `${key}${TEST_KEY_SUFFIX}`;
}

/**
 * Whether `key` is one of {@link testConnectionKey}: such connections only last for the test
 * and are not listed as connections of the window.
 */
export function isTestConnectionKey(key: string): boolean {
  // Server ids cannot contain a line break, so only a test key has two of them.
  return key.split('\n').length === 3 && key.endsWith(TEST_KEY_SUFFIX);
}

/**
 * The server a command argument names: a connection key, or a server id when exactly one
 * folder has a server with that id.
 */
export function findChoice(
  choices: readonly SftpServerChoice[],
  argument: string,
): SftpServerChoice | undefined {
  const byKey = choices.find((choice) => choice.key === argument);
  if (byKey !== undefined) {
    return byKey;
  }
  const byId = choices.filter((choice) => choice.server.id === argument);
  return byId.length === 1 ? byId[0] : undefined;
}

/** The SFTP servers of every folder whose configuration loaded, in folder order. */
export function configuredSftpServers(
  snapshot: FoldersSnapshot,
  platform: 'posix' | 'win32' = process.platform === 'win32' ? 'win32' : 'posix',
): SftpServerChoice[] {
  const api = platform === 'win32' ? win32 : posix;
  const choices: SftpServerChoice[] = [];
  for (const { folder, result } of snapshot.statuses) {
    if (result.status !== 'ok') {
      continue;
    }
    for (const server of result.config.servers) {
      if (server.type === 'sftp') {
        choices.push({
          key: connectionKey(folder.key, server.id),
          server,
          folderName: folder.name,
          configFile: api.join(result.dir, CONFIG_FILE_NAME),
        });
      }
    }
  }
  return choices;
}
