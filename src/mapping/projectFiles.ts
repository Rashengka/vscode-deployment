/**
 * The files of a project, as git knows them, for Verify Mapping. Without the VS Code API; the
 * settings panel falls back to the workspace files when this fails.
 *
 * Running git in a repository can run code the repository configures (`.git/config`), so:
 *
 * - git is started by its absolute path, found on `PATH` without relative entries and without
 *   folders inside the project (a `git` planted in the project is never run),
 * - `core.fsmonitor` is switched off on the command line, so that no hook of the repository
 *   runs (`ls-files` would otherwise start it),
 * - the caller runs it only in a trusted workspace,
 * - no shell is involved, output is NUL-separated (`-z`) and bounded in size and time.
 */
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { hasInvisibleCharacters } from '../display/sanitize';

export const MAX_PROJECT_FILES = 200_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

/** Variables that would point git at another repository, index or work tree. */
const REPOSITORY_VARIABLES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
];

export class GitFilesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitFilesError';
  }
}

export interface FindOptions {
  readonly platform: NodeJS.Platform;
  /** The project folder: git is never taken from inside it. */
  readonly projectRoot: string;
  /** The canonical path (symbolic links resolved), or `undefined` when it does not exist. */
  readonly realpath: (path: string) => string | undefined;
  readonly isExecutableFile: (file: string) => boolean;
}

/**
 * The absolute, canonical path of `name` from `pathVariable`, or `undefined`. PATH entries and
 * the program itself are compared with the project by their real paths (a symbolic link into
 * the project counts as inside it), without regard to case on macOS and Windows.
 */
export function findExecutable(
  name: string,
  pathVariable: string | undefined,
  options: FindOptions,
): string | undefined {
  const { platform } = options;
  const api = platform === 'win32' ? path.win32 : path.posix;
  const fold = (value: string): string =>
    platform === 'darwin' || platform === 'win32' ? value.toLowerCase() : value;
  const root = fold(options.realpath(options.projectRoot) ?? options.projectRoot);
  const inside = (candidate: string): boolean => {
    const relative = api.relative(root, fold(candidate));
    return relative === '' || (!relative.startsWith('..') && !api.isAbsolute(relative));
  };
  const file = platform === 'win32' ? `${name}.exe` : name;
  for (const dir of (pathVariable ?? '').split(api.delimiter)) {
    if (dir === '' || !api.isAbsolute(dir)) {
      continue;
    }
    const realDir = options.realpath(dir);
    if (realDir === undefined || inside(realDir)) {
      continue;
    }
    const candidate = options.realpath(api.join(realDir, file));
    if (candidate !== undefined && !inside(candidate) && options.isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export interface ProjectFileList {
  /** Relative to the folder git ran in, with forward slashes. */
  readonly files: readonly string[];
  /** More files than {@link MAX_PROJECT_FILES}; the rest was left out. */
  readonly truncated: boolean;
}

/**
 * Whether a listed path can name a project file: relative, with forward slashes, without `..`
 * segments and without invisible characters. A crafted index could list anything else, and
 * such a path could point above the server's root path.
 */
export function isProjectPath(entry: string): boolean {
  return (
    entry !== '' &&
    !entry.startsWith('/') &&
    !entry.includes('\\') &&
    !entry.split('/').includes('..') &&
    !hasInvisibleCharacters(entry)
  );
}

export function parseLsFiles(output: string): ProjectFileList {
  const all = output.split('\0').filter(isProjectPath);
  return {
    files: all.slice(0, MAX_PROJECT_FILES),
    truncated: all.length > MAX_PROJECT_FILES,
  };
}

/** `git ls-files` in `cwd`: the tracked files below it, relative to it. */
export function gitLsFiles(
  git: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<ProjectFileList> {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(environment).filter(([name]) => !REPOSITORY_VARIABLES.includes(name)),
  );
  env['GIT_OPTIONAL_LOCKS'] = '0';
  env['GIT_TERMINAL_PROMPT'] = '0';
  return new Promise((resolve, reject) => {
    execFile(
      git,
      ['-c', 'core.fsmonitor=false', 'ls-files', '-z'],
      {
        cwd,
        env,
        encoding: 'utf8',
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: TIMEOUT_MS,
        windowsHide: true,
        shell: false,
      },
      (error, stdout) => {
        if (error !== null) {
          // The message would quote git's stderr, which may contain paths; the code is enough.
          reject(new GitFilesError(`git ls-files failed (${String(error.code ?? 'unknown')}).`));
          return;
        }
        resolve(parseLsFiles(stdout));
      },
    );
  });
}

export interface ProjectFiles {
  /** Relative to the project folder, with forward slashes. */
  readonly files: readonly string[];
  readonly source: 'git' | 'workspace';
  /** More files than {@link MAX_PROJECT_FILES}; the rest was left out. */
  readonly truncated: boolean;
}

/** Where the project files can come from (the VS Code part is passed in). */
export interface ProjectFileSources {
  readonly trusted: boolean;
  findGit(): string | undefined;
  gitLsFiles(git: string): Promise<ProjectFileList>;
  /**
   * The workspace files of the project, relative to it; same arguments as
   * `vscode.workspace.findFiles` (an `undefined` exclude keeps the `files.exclude` setting).
   */
  findFiles(include: string, exclude: undefined, maxResults: number): Promise<readonly string[]>;
  log(message: string): void;
}

/**
 * The project files for Verify Mapping: `git ls-files` in a trusted workspace when git is
 * installed and lists something, otherwise the workspace files. `.git` is never listed.
 */
export async function collectProjectFiles(sources: ProjectFileSources): Promise<ProjectFiles> {
  const git = sources.trusted ? sources.findGit() : undefined;
  if (git !== undefined) {
    try {
      const listed = await sources.gitLsFiles(git);
      if (listed.files.length > 0) {
        return { files: listed.files, source: 'git', truncated: listed.truncated };
      }
      sources.log('git ls-files listed no files. Using the workspace files.');
    } catch (error) {
      if (!(error instanceof GitFilesError)) {
        throw error;
      }
      sources.log(`${error.message} Using the workspace files.`);
    }
  }
  const found = (await sources.findFiles('**/*', undefined, MAX_PROJECT_FILES + 1)).filter(
    (file) => isProjectPath(file) && !file.split('/').includes('.git'),
  );
  return {
    files: found.slice(0, MAX_PROJECT_FILES),
    source: 'workspace',
    truncated: found.length > MAX_PROJECT_FILES,
  };
}
