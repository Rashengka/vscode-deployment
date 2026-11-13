/**
 * Loading and saving the configuration of one project folder.
 *
 * - The project is identified by its canonical path (`realpath`: symbolic links resolved and,
 *   on case-insensitive file systems, the on-disk spelling). Every function canonicalizes the
 *   folder it is given.
 * - The folder name is the encoded path. When that folder holds the configuration of another
 *   project (the encoding is not injective), the name with a hash suffix is used instead, so
 *   that each project always gets a configuration of its own.
 * - Which project a configuration belongs to is decided only by the `projectPath` it records.
 *   When that cannot be read from a file in the shared encoded folder, nobody may use the file
 *   through the extension: it could be another project's. The folder with the hash suffix is
 *   addressed to exactly one project, so an unreadable file there is that project's to repair.
 * - Nothing is read from a folder or file that fails the ownership and permission checks.
 */
import { constants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { createFileExclusive, writeFileAtomic } from './atomicWrite';
import {
  DIR_MODE,
  checkEntry,
  currentUid,
  entryProblem,
  errorCode,
  isNotFound,
  isPermissionDenied,
} from './fileSafety';
import { describeJsonError } from './messages';
import { migrateConfig } from './migrate';
import {
  CONFIG_FILE_NAME,
  STATE_FILE_NAME,
  emptyConfig,
  emptyState,
  type DeploymentConfig,
  type DeploymentState,
} from './model';
import { disambiguatedName, encodeProjectPath, projectsDir } from './paths';
import { mergeState, validateState, type StateUpdate } from './state';
import { validateConfig } from './validate';

export interface StoreOptions {
  /** The configuration root (see `configRoot`). */
  readonly root: string;
  readonly platform?: NodeJS.Platform;
  /** Owner expected by the safety checks; `null` disables them (Windows). */
  readonly uid?: number | null;
}

export type LoadResult =
  | { readonly status: 'missing'; readonly dir: string }
  | {
      readonly status: 'ok';
      readonly dir: string;
      readonly config: DeploymentConfig;
      /** The version the file was migrated from, or `null` when it was current. */
      readonly migratedFrom: number | null;
    }
  | {
      readonly status: 'invalid';
      /** The folder concerned, or `null` when the project folder itself cannot be resolved. */
      readonly dir: string | null;
      readonly errors: readonly string[];
    }
  | { readonly status: 'unsafe'; readonly problem: string };

/** Thrown when a folder or file fails the ownership and permission checks. */
export class UnsafeConfigError extends Error {
  readonly problem: string;

  constructor(problem: string) {
    super(`Refusing to use the deployment configuration: ${problem}.`);
    this.name = 'UnsafeConfigError';
    this.problem = problem;
  }
}

/** Thrown when a configuration or state file exists but cannot be used. */
export class InvalidConfigError extends Error {
  readonly file: string;
  readonly errors: readonly string[];

  constructor(file: string, errors: readonly string[]) {
    super(`${file} is not valid: ${errors.join('; ')}`);
    this.name = 'InvalidConfigError';
    this.file = file;
    this.errors = errors;
  }
}

/** Thrown when the configuration folder of a project cannot be told apart from another's. */
export class UnownedConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnownedConfigError';
  }
}

interface Resolved {
  readonly root: string;
  readonly platform: NodeJS.Platform;
  readonly uid: number | null;
  readonly projects: string;
}

function resolveOptions(options: StoreOptions): Resolved {
  const platform = options.platform ?? process.platform;
  return {
    root: options.root,
    platform,
    uid: options.uid === undefined ? currentUid() : options.uid,
    projects: projectsDir(options.root, platform),
  };
}

/** The canonical form of a project folder path. The folder must exist. */
export async function canonicalProjectPath(folder: string): Promise<string> {
  return realpath(folder);
}

/** Errors that mean "this path does not name an accessible folder". */
const UNRESOLVABLE = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'ENAMETOOLONG']);

/** Whether `stored` names the same folder as the canonical `projectPath`. */
export async function isSameProject(stored: string, projectPath: string): Promise<boolean> {
  if (stored === projectPath) {
    return true;
  }
  try {
    return (await realpath(stored)) === projectPath;
  } catch (error) {
    const code = errorCode(error);
    if (code !== undefined && UNRESOLVABLE.has(code)) {
      return false;
    }
    throw error;
  }
}

/**
 * Reads a file without following a symbolic link and checks owner, mode and type on the
 * opened file itself. Returns `null` when the file does not exist.
 */
async function readCheckedFile(file: string, uid: number | null): Promise<string | null> {
  // O_NONBLOCK keeps a named pipe planted in place of the file from blocking the open.
  const posixFlags = uid === null ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | posixFlags);
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    if (errorCode(error) === 'ELOOP') {
      throw new UnsafeConfigError(`${file} is a symbolic link`);
    }
    if (isPermissionDenied(error)) {
      throw new UnsafeConfigError(`${file} cannot be read (permission denied)`);
    }
    throw error;
  }
  try {
    if (uid !== null) {
      const problem = entryProblem(await handle.stat(), 'file', uid);
      if (problem !== null) {
        throw new UnsafeConfigError(`${file} ${problem}`);
      }
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function checkDirectories(dirs: readonly string[], uid: number | null): Promise<void> {
  for (const dir of dirs) {
    const problem = await checkEntry(dir, 'directory', uid);
    if (problem !== null) {
      throw new UnsafeConfigError(problem);
    }
  }
}

type ParsedFile =
  | { readonly kind: 'missing' }
  | { readonly kind: 'json'; readonly value: unknown }
  | { readonly kind: 'unparsable'; readonly error: string; readonly text: string };

async function readJson(file: string, uid: number | null): Promise<ParsedFile> {
  const raw = await readCheckedFile(file, uid);
  if (raw === null) {
    return { kind: 'missing' };
  }
  // Editors on Windows may add a byte order mark.
  const text = raw.replace(/^\uFEFF/, '');
  try {
    return { kind: 'json', value: JSON.parse(text) as unknown };
  } catch (error) {
    if (error instanceof SyntaxError) {
      // The parser's own message quotes the file content; never pass it on.
      return { kind: 'unparsable', error: describeJsonError(error, text), text };
    }
    throw error;
  }
}

/**
 * The `projectPath` of a file that is not valid JSON, when exactly one such property can still
 * be read from it (for example when the syntax error is elsewhere).
 */
function recoverProjectPath(text: string): string | null {
  const matches = [...text.matchAll(/"projectPath"\s*:\s*("(?:[^"\\\n]|\\.)*")/g)];
  const literal = matches.length === 1 ? matches[0]?.[1] : undefined;
  if (literal === undefined) {
    return null;
  }
  try {
    const value = JSON.parse(literal) as unknown;
    return typeof value === 'string' ? value : null;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

function recordedProjectPath(parsed: ParsedFile): string | null {
  if (parsed.kind === 'unparsable') {
    return recoverProjectPath(parsed.text);
  }
  if (parsed.kind === 'json' && typeof parsed.value === 'object' && parsed.value !== null) {
    const stored = (parsed.value as Record<string, unknown>)['projectPath'];
    return typeof stored === 'string' ? stored : null;
  }
  return null;
}

type Occupant =
  | { readonly kind: 'free' }
  | { readonly kind: 'ours'; readonly parsed: ParsedFile }
  | { readonly kind: 'other' }
  | { readonly kind: 'unknown'; readonly parsed: ParsedFile };

/** Who the configuration in `dir` belongs to, judged by the `projectPath` it records. */
async function inspect(dir: string, projectPath: string, uid: number | null): Promise<Occupant> {
  await checkDirectories([dir], uid);
  const parsed = await readJson(path.join(dir, CONFIG_FILE_NAME), uid);
  if (parsed.kind === 'missing') {
    return { kind: 'free' };
  }
  const stored = recordedProjectPath(parsed);
  if (stored === null) {
    return { kind: 'unknown', parsed };
  }
  return (await isSameProject(stored, projectPath)) ? { kind: 'ours', parsed } : { kind: 'other' };
}

type Placement =
  | {
      readonly kind: 'use';
      readonly dir: string;
      /** `unknown` only for the hash-suffixed folder, which no other project can use. */
      readonly occupant: Exclude<Occupant, { kind: 'other' }>;
    }
  | { readonly kind: 'refuse'; readonly dir: string; readonly reason: string };

/** Decides which folder belongs to `projectPath`, or why none can be used safely. */
async function place(projectPath: string, resolved: Resolved): Promise<Placement> {
  await checkDirectories([resolved.root, resolved.projects], resolved.uid);
  const primary = path.join(resolved.projects, encodeProjectPath(projectPath));
  const alternate = path.join(resolved.projects, disambiguatedName(projectPath));
  const alt = await inspect(alternate, projectPath, resolved.uid);
  if (alt.kind === 'ours' || alt.kind === 'unknown') {
    return { kind: 'use', dir: alternate, occupant: alt };
  }
  const prim = await inspect(primary, projectPath, resolved.uid);
  switch (prim.kind) {
    case 'free':
    case 'ours':
      return { kind: 'use', dir: primary, occupant: prim };
    case 'other':
      return alt.kind === 'free'
        ? { kind: 'use', dir: alternate, occupant: alt }
        : {
            kind: 'refuse',
            dir: alternate,
            reason: `${path.join(alternate, CONFIG_FILE_NAME)} belongs to another project folder`,
          };
    case 'unknown':
      return {
        kind: 'refuse',
        dir: primary,
        reason: `${path.join(primary, CONFIG_FILE_NAME)} does not say which project folder it belongs to (its "projectPath" cannot be read), so it may belong to another project; fix or remove it`,
      };
  }
}

/**
 * Loads the configuration of the project `folder`. Never throws for a missing, invalid or
 * unsafe configuration; those are reported in the result.
 */
export async function loadConfig(folder: string, options: StoreOptions): Promise<LoadResult> {
  const resolved = resolveOptions(options);
  let projectPath: string;
  try {
    projectPath = await canonicalProjectPath(folder);
  } catch (error) {
    const code = errorCode(error);
    if (code !== undefined && UNRESOLVABLE.has(code)) {
      return {
        status: 'invalid',
        dir: null,
        errors: [`the project folder cannot be resolved (${code})`],
      };
    }
    throw error;
  }
  try {
    const placement = await place(projectPath, resolved);
    if (placement.kind === 'refuse') {
      return { status: 'invalid', dir: placement.dir, errors: [placement.reason] };
    }
    const { dir, occupant } = placement;
    if (occupant.kind === 'free') {
      return { status: 'missing', dir };
    }
    const parsed = occupant.parsed;
    if (parsed.kind === 'unparsable') {
      return { status: 'invalid', dir, errors: [parsed.error] };
    }
    if (parsed.kind !== 'json') {
      return { status: 'missing', dir };
    }
    const migrated = migrateConfig(parsed.value);
    if (!migrated.ok) {
      return { status: 'invalid', dir, errors: [migrated.error] };
    }
    const validated = validateConfig(migrated.value, { platform: resolved.platform });
    if (!validated.ok) {
      return { status: 'invalid', dir, errors: validated.errors };
    }
    // Ownership was judged on the file as read; check the migrated result again.
    if (!(await isSameProject(validated.config.projectPath, projectPath))) {
      return {
        status: 'invalid',
        dir,
        errors: ['projectPath: belongs to a different project folder'],
      };
    }
    return { status: 'ok', dir, config: validated.config, migratedFrom: migrated.migratedFrom };
  } catch (error) {
    if (error instanceof UnsafeConfigError) {
      return { status: 'unsafe', problem: error.problem };
    }
    throw error;
  }
}

/** The folder of `projectPath` for writing, created with mode 0700 and checked again. */
async function prepareDir(
  projectPath: string,
  resolved: Resolved,
): Promise<Extract<Placement, { kind: 'use' }>> {
  const placement = await place(projectPath, resolved);
  if (placement.kind === 'refuse') {
    throw new UnownedConfigError(placement.reason);
  }
  await mkdir(placement.dir, { recursive: true, mode: DIR_MODE });
  await checkDirectories([resolved.root, resolved.projects, placement.dir], resolved.uid);
  return placement;
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Attempts before giving up when another window keeps changing the folders meanwhile. */
const PLACEMENT_ATTEMPTS = 2;

/**
 * Writes `config.json` of `projectPath`. A free folder is claimed without replacing anything,
 * so that a project that took the folder in the meantime is noticed and the next folder is
 * chosen; a folder that is already ours is replaced atomically.
 */
async function writeConfigFile(
  projectPath: string,
  resolved: Resolved,
  content: (existing: boolean) => string | null,
): Promise<{ readonly file: string; readonly created: boolean }> {
  for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt++) {
    const { dir, occupant } = await prepareDir(projectPath, resolved);
    const file = path.join(dir, CONFIG_FILE_NAME);
    if (occupant.kind !== 'free') {
      const data = content(true);
      if (data !== null) {
        await writeFileAtomic(file, data);
      }
      return { file, created: false };
    }
    const data = content(false);
    if (data !== null && (await createFileExclusive(file, data))) {
      return { file, created: true };
    }
    // Another window created the file first: decide again whose it is.
  }
  throw new UnownedConfigError(
    'The deployment configuration folders changed while saving; try again.',
  );
}

/**
 * Saves `config` atomically. Throws `InvalidConfigError` for a configuration that would not
 * load again, `UnsafeConfigError` when the folders fail the safety checks and
 * `UnownedConfigError` when the folder may belong to another project.
 */
export async function saveConfig(
  folder: string,
  config: DeploymentConfig,
  options: StoreOptions,
): Promise<string> {
  const resolved = resolveOptions(options);
  const projectPath = await canonicalProjectPath(folder);
  const validated = validateConfig(config, { platform: resolved.platform });
  if (!validated.ok) {
    throw new InvalidConfigError(CONFIG_FILE_NAME, validated.errors);
  }
  if (!(await isSameProject(config.projectPath, projectPath))) {
    throw new InvalidConfigError(CONFIG_FILE_NAME, [
      'projectPath: belongs to a different project folder',
    ]);
  }
  const data = serialize(validated.config);
  const { file } = await writeConfigFile(projectPath, resolved, () => data);
  return file;
}

/**
 * Returns the path of the configuration file of the project `folder`, creating an empty valid
 * configuration first when there is none. An existing file is never replaced, and a file that
 * may belong to another project is never returned.
 */
export async function ensureConfigFile(
  folder: string,
  options: StoreOptions,
): Promise<{ readonly file: string; readonly created: boolean }> {
  const resolved = resolveOptions(options);
  const projectPath = await canonicalProjectPath(folder);
  const data = serialize(emptyConfig(projectPath));
  return writeConfigFile(projectPath, resolved, (existing) => (existing ? null : data));
}

/** The folder whose configuration belongs to `projectPath`, or `null` when there is none. */
async function ownedDir(projectPath: string, resolved: Resolved): Promise<string | null> {
  const placement = await place(projectPath, resolved);
  if (placement.kind === 'refuse') {
    throw new UnownedConfigError(placement.reason);
  }
  switch (placement.occupant.kind) {
    case 'free':
      return null;
    case 'ours':
      return placement.dir;
    case 'unknown':
      throw new UnownedConfigError(
        `${path.join(placement.dir, CONFIG_FILE_NAME)} does not say which project folder it belongs to; fix it first`,
      );
  }
}

async function readState(dir: string, projectPath: string, uid: number | null) {
  const file = path.join(dir, STATE_FILE_NAME);
  const parsed = await readJson(file, uid);
  if (parsed.kind === 'missing') {
    return emptyState(projectPath);
  }
  if (parsed.kind === 'unparsable') {
    throw new InvalidConfigError(file, [parsed.error]);
  }
  const validated = validateState(parsed.value);
  if (!validated.ok) {
    throw new InvalidConfigError(file, validated.errors);
  }
  // A history left behind by another project in a shared folder is never adopted.
  if (!(await isSameProject(validated.state.projectPath, projectPath))) {
    throw new InvalidConfigError(file, ['projectPath: belongs to a different project folder']);
  }
  return { ...validated.state, projectPath };
}

/**
 * Loads `state.json` of the project `folder` from the folder holding its configuration (empty
 * when there is no configuration or no history yet). Throws for an unsafe, invalid or foreign
 * file.
 */
export async function loadState(folder: string, options: StoreOptions): Promise<DeploymentState> {
  const resolved = resolveOptions(options);
  const projectPath = await canonicalProjectPath(folder);
  const dir = await ownedDir(projectPath, resolved);
  return dir === null ? emptyState(projectPath) : readState(dir, projectPath, resolved.uid);
}

/**
 * Applies `updates` to the current `state.json` on disk and saves the result, so that entries
 * written by another window in the meantime are kept. Requires the project's configuration.
 */
export async function updateState(
  folder: string,
  updates: readonly StateUpdate[],
  options: StoreOptions,
): Promise<DeploymentState> {
  const resolved = resolveOptions(options);
  const projectPath = await canonicalProjectPath(folder);
  const dir = await ownedDir(projectPath, resolved);
  if (dir === null) {
    throw new UnownedConfigError('The project has no deployment configuration.');
  }
  await checkDirectories([resolved.root, resolved.projects, dir], resolved.uid);
  const merged = mergeState(await readState(dir, projectPath, resolved.uid), updates);
  await writeFileAtomic(path.join(dir, STATE_FILE_NAME), serialize(merged));
  return merged;
}
