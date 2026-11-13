/**
 * Values of the context keys that show or hide commands, computed from the configurations of
 * all workspace folders.
 */
import type { Server } from './model';
import type { LoadResult } from './store';

export const CONTEXT_HAS_CONFIG = 'vscodeDeployment.hasConfig';
export const CONTEXT_HAS_UPLOAD_TARGET = 'vscodeDeployment.hasUploadTarget';

export interface ContextKeyValues {
  readonly hasConfig: boolean;
  readonly hasUploadTarget: boolean;
}

/**
 * Files can be uploaded to an SFTP server with at least one mapping. An in-place server runs
 * from the project folder itself, so nothing is ever uploaded to it.
 */
export function isUploadTarget(server: Server): boolean {
  return server.type === 'sftp' && server.mappings.length > 0;
}

export function computeContextKeys(results: readonly LoadResult[]): ContextKeyValues {
  const servers = results.flatMap((result) =>
    result.status === 'ok' ? result.config.servers : [],
  );
  return {
    hasConfig: servers.length > 0,
    hasUploadTarget: servers.some(isUploadTarget),
  };
}
