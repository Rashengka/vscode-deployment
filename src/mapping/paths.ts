/**
 * Local and remote paths of a server's mappings and exclusions, without the VS Code API.
 *
 * Paths in the configuration are relative (to the project folder or to the server's root path),
 * use forward slashes and never contain `..` (`src/config/validate.ts` refuses them), so they
 * are compared segment by segment here: `var/cache` excludes `var/cache/x` but not
 * `var/cache2/x`.
 */
import * as path from 'node:path';
import type { Mapping } from '../config/model';

/** The segments of a relative path; `.`, empty segments and `""` stand for the base. */
export function pathSegments(relative: string): string[] {
  return relative.split('/').filter((segment) => segment !== '' && segment !== '.');
}

function startsWith(segments: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= segments.length && prefix.every((part, i) => segments[i] === part);
}

/** Whether `relative` is one of `excluded` or inside one of them. */
export function isExcluded(relative: string, excluded: readonly string[]): boolean {
  const segments = pathSegments(relative);
  return excluded.some((entry) => startsWith(segments, pathSegments(entry)));
}

export interface MappingMatch {
  readonly index: number;
  readonly mapping: Mapping;
  /** The segments of the file below the mapping's local path. */
  readonly rest: readonly string[];
}

/** The mapping a project file belongs to: the one with the longest matching local path. */
export function mappingFor(
  mappings: readonly Mapping[],
  localRelative: string,
): MappingMatch | undefined {
  const segments = pathSegments(localRelative);
  let best: MappingMatch | undefined;
  let bestLength = -1;
  mappings.forEach((mapping, index) => {
    const prefix = pathSegments(mapping.localPath);
    if (prefix.length > bestLength && startsWith(segments, prefix)) {
      best = { index, mapping, rest: segments.slice(prefix.length) };
      bestLength = prefix.length;
    }
  });
  return best;
}

export class PathOutsideRootError extends Error {
  constructor() {
    super('A path on the server would be outside the root path.');
    this.name = 'PathOutsideRootError';
  }
}

/**
 * The absolute path on the server below `rootPath` and a mapping's deployment path. Throws
 * {@link PathOutsideRootError} when the result would not be below `rootPath` (a `..` in
 * `rest`, which validated configuration paths never have), so that nothing above it is ever
 * looked at.
 */
export function remotePathOf(
  rootPath: string,
  deploymentPath: string,
  rest: readonly string[],
): string {
  const joined = path.posix.join(rootPath, ...pathSegments(deploymentPath), ...rest);
  const relative = path.posix.relative(path.posix.normalize(rootPath), joined);
  if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) {
    throw new PathOutsideRootError();
  }
  return joined;
}

/**
 * `target` relative to `base` with forward slashes (`.` for the base itself), or `null` when
 * it is not inside `base` or cannot be written as a configuration path. Both are expected to
 * be canonical (symbolic links resolved), so that a link out of the project is not taken for a
 * path inside it.
 */
export function projectRelativePath(
  base: string,
  target: string,
  platform: NodeJS.Platform,
): string | null {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const relative = api.relative(base, target);
  if (relative === '') {
    return '.';
  }
  if (api.isAbsolute(relative) || relative.split(api.sep).includes('..')) {
    return null;
  }
  if (platform !== 'win32' && relative.includes('\\')) {
    return null;
  }
  return relative.split(api.sep).join('/');
}
