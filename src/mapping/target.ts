/**
 * Where a project file goes on a server, without the VS Code API. Shared by Verify Mapping,
 * Compare with Deployed Version and upload, so that they never disagree: the mapping with the
 * longest local path, and nothing that is excluded locally or on the server.
 */
import type { SftpServer } from '../config/model';
import {
  PathOutsideRootError,
  isExcluded,
  mappingFor,
  pathSegments,
  projectRelativePath,
  remotePathOf,
} from './paths';

export type MappedServer = Pick<
  SftpServer,
  'rootPath' | 'mappings' | 'excludedLocalPaths' | 'excludedRemotePaths'
>;

export type RemoteTarget =
  | {
      readonly kind: 'ok';
      readonly mappingIndex: number;
      /** Absolute on the server, below the server's root path. */
      readonly remotePath: string;
    }
  /** No mapping covers the file. */
  | { readonly kind: 'unmapped' }
  /** The file belongs to the mapping `mappingIndex` but is excluded locally or on the server. */
  | { readonly kind: 'excluded'; readonly mappingIndex: number };

/**
 * The file on the server for the project file `localRelative` (relative to the project folder,
 * with forward slashes). Throws {@link PathOutsideRootError} like {@link remotePathOf} when the
 * result would not be below the root path.
 */
export function remoteTargetOf(server: MappedServer, localRelative: string): RemoteTarget {
  const match = mappingFor(server.mappings, localRelative);
  if (match === undefined) {
    return { kind: 'unmapped' };
  }
  const belowRoot = [...pathSegments(match.mapping.deploymentPath), ...match.rest].join('/');
  if (
    isExcluded(localRelative, server.excludedLocalPaths) ||
    isExcluded(belowRoot, server.excludedRemotePaths)
  ) {
    return { kind: 'excluded', mappingIndex: match.index };
  }
  return {
    kind: 'ok',
    mappingIndex: match.index,
    remotePath: remotePathOf(server.rootPath, match.mapping.deploymentPath, match.rest),
  };
}

export type LocalFileTarget =
  | {
      readonly kind: 'ok';
      /** Relative to the project folder, with forward slashes. */
      readonly localRelative: string;
      readonly mappingIndex: number;
      readonly remotePath: string;
    }
  /** The file is not inside the project folder (or is the folder itself). */
  | { readonly kind: 'outside' }
  /** The path on the server would not be below the root path. */
  | { readonly kind: 'outsideRoot' }
  | { readonly kind: 'unmapped' }
  | { readonly kind: 'excluded' };

/**
 * {@link remoteTargetOf} for a local file given by its absolute path. `projectDir` and
 * `localFile` must be canonical (symbolic links resolved), so that a link out of the project is
 * not taken for a project file.
 */
export function localFileTarget(
  server: MappedServer,
  projectDir: string,
  localFile: string,
  platform: NodeJS.Platform,
): LocalFileTarget {
  const localRelative = projectRelativePath(projectDir, localFile, platform);
  if (localRelative === null || localRelative === '.') {
    return { kind: 'outside' };
  }
  let target: RemoteTarget;
  try {
    target = remoteTargetOf(server, localRelative);
  } catch (error) {
    if (error instanceof PathOutsideRootError) {
      return { kind: 'outsideRoot' };
    }
    throw error;
  }
  switch (target.kind) {
    case 'unmapped':
      return { kind: 'unmapped' };
    case 'excluded':
      return { kind: 'excluded' };
    case 'ok':
      return { localRelative, ...target };
  }
}
