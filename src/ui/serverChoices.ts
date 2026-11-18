/** The servers Test Connection can be used with. Kept free of the VS Code API. */
import { posix, win32 } from 'node:path';
import type { FoldersSnapshot } from '../config/folders';
import { CONFIG_FILE_NAME, type SftpServer } from '../config/model';

export interface SftpServerChoice {
  readonly server: SftpServer;
  readonly folderName: string;
  /** The config.json the server comes from (watched while connected). */
  readonly configFile: string;
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
          server,
          folderName: folder.name,
          configFile: api.join(result.dir, CONFIG_FILE_NAME),
        });
      }
    }
  }
  return choices;
}
