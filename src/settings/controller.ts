/**
 * The extension host side of one settings panel (one workspace folder), without the VS Code
 * API: the panel in `src/webview/settingsPanel.ts` passes dialogs, the store and the connection
 * manager in through {@link SettingsHost}.
 *
 * - Every message from the webview is checked by `parseWebviewMessage`; one that does not match
 *   is dropped and logged by its type only.
 * - Saving validates with the rules of `config.json` and writes through the store with the
 *   loaded configuration as the expected one, so a file changed elsewhere is never overwritten:
 *   the webview then shows that it changed and offers to reload.
 * - Operations on a server (Test Connection, Autodetect, the remote folder picker, Verify
 *   Mapping) run in the extension host with the unsaved form, on a connection of their own that
 *   is closed afterwards; the passphrase prompt stays there too. At most one runs per panel.
 * - The remote folder picker lists only folders below its base folder that it listed itself
 *   (`remoteBrowser.ts`); names from the server reach the webview sanitized for display.
 * - Messages are handled one after another, except server operations and the file pickers,
 *   which wait for the user. A message that is too large is dropped before it is looked at.
 */
import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import type { DeploymentConfig, SftpServer } from '../config/model';
import { projectRelativePath } from '../mapping/paths';
import type { ProjectFiles } from '../mapping/projectFiles';
import {
  VERIFY_SAMPLE_SIZE,
  overallPassed,
  planVerification,
  verdictText,
  verifyMappings,
  type RandomIndex,
} from '../mapping/verify';
import type { DeploymentTarget } from '../transport/deploymentTarget';
import { connectionFailure } from '../ui/connectionFailures';
import {
  ConfigChangedError,
  InvalidConfigError,
  UnownedConfigError,
  UnsafeConfigError,
  type LoadResult,
} from '../config/store';
import { hasInvisibleCharacters, sanitizeForDisplay } from '../display/sanitize';
import type { DeploymentLog } from '../log/deploymentLog';
import { SshConfigError } from '../ssh/sshConfig';
import { ConnectionError } from '../ssh/connectionManager';
import type { TestConnectionResult } from '../ui/testConnectionFlow';
import { sameDrafts, type ServerDraft, type SftpDraft } from './draft';
import {
  MAX_MESSAGE_SIZE,
  MAX_REMOTE_ENTRIES,
  MAX_TEXT_LENGTH,
  exceedsSize,
  parseWebviewMessage,
  type BrowsePurpose,
  type FormError,
  type HostMessage,
  type LocalList,
  type PathField,
  type PickedField,
  type ServerTask,
  type WebviewMessage,
} from './protocol';
import { RemoteBrowser } from './remoteBrowser';
import { buildConfig, draftsFromConfig, sftpServerFromDraft } from './save';

/** A connection with unsaved settings (see `testUnsavedServer.ts`). */
export interface ServerSession {
  run<T>(operation: (target: DeploymentTarget) => Promise<T>): Promise<T>;
  /** Closes the connection; later operations fail. */
  close(): void;
}

export interface SettingsHost {
  /** Name of the workspace folder, for the panel. */
  readonly folderName: string;
  readonly platform: NodeJS.Platform;
  readonly log: DeploymentLog;
  post(message: HostMessage): void;
  load(): Promise<LoadResult>;
  /** The canonical path of the workspace folder (`projectPath` of a new configuration). */
  projectPath(): Promise<string>;
  /** Saves through the store; throws `ConfigChangedError` when the file is not `expected`. */
  save(config: DeploymentConfig, expected: DeploymentConfig | null): Promise<void>;
  /** The `Host` aliases of the SSH config; may throw `SshConfigError` or a file system error. */
  listAliases(): Promise<readonly string[]>;
  /** Shows a file or folder picker; `undefined` when cancelled. */
  pickPath(field: PathField, current: string): Promise<string | undefined>;
  /**
   * Shows a folder picker (mappings) or a file and folder picker (exclusions) that starts in
   * the project folder, at `current` (relative) when set. Gives the chosen path with symbolic
   * links resolved, or `undefined` when cancelled.
   */
  pickProjectPath(list: LocalList, current: string | null): Promise<string | undefined>;
  /** Opens a connection with the unsaved settings of `server` (connecting on first use). */
  openSession(server: SftpServer): ServerSession;
  /** The project files for Verify Mapping: from git when possible, else the workspace. */
  listProjectFiles(): Promise<ProjectFiles>;
  /** Random numbers for the sample of Verify Mapping. */
  readonly random: RandomIndex;
  /** Runs Test Connection (its notifications included); `undefined` when it did not connect. */
  testConnection(server: SftpServer): Promise<TestConnectionResult | undefined>;
  /** Closes the connection of a server of this folder, if one is open. */
  disconnect(serverId: string): void;
  /** Called after every successful save (for example to refresh the context keys). */
  onSaved(): void;
}

export type Loaded =
  | { readonly kind: 'usable'; readonly config: DeploymentConfig | null }
  | { readonly kind: 'unusable'; readonly problem: string };

/**
 * What a panel that is closed with unsaved changes passes to the one that opens again: the
 * edits, the configuration they were made against (the one a Save may replace) and whether that
 * configuration is known to have changed on disk.
 */
export interface SettingsSnapshot {
  readonly draft: readonly ServerDraft[];
  readonly loaded: Loaded | undefined;
  readonly changedOnDisk: boolean;
}

const CHANGED_ON_DISK =
  'The configuration was changed outside this panel since it was loaded, so it was not saved. ' +
  'Reload to see the current configuration (your edits are discarded).';

function serialize(config: DeploymentConfig | null): string {
  return JSON.stringify(config);
}

function describeLoad(result: LoadResult): Loaded {
  switch (result.status) {
    case 'ok':
      return { kind: 'usable', config: result.config };
    case 'missing':
      return { kind: 'usable', config: null };
    case 'unsafe':
      return {
        kind: 'unusable',
        problem: `The deployment configuration was not loaded: ${result.problem}.`,
      };
    case 'invalid': {
      const [first, ...rest] = result.errors;
      const more = rest.length > 0 ? ` (and ${rest.length} more)` : '';
      return {
        kind: 'unusable',
        problem:
          `The deployment configuration is not valid: ${first ?? 'unknown error'}${more}. ` +
          'Fix it with Deployment: Open Deployment Config (JSON), then reload.',
      };
    }
  }
}

function isFileSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';
}

function isSaveMessage(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && (raw as { type?: unknown }).type === 'save';
}

function errorCode(error: NodeJS.ErrnoException): string {
  return sanitizeForDisplay(String(error.code), { maxLength: 40 });
}

type RunningTask = 'test' | ServerTask | 'browse';

const TASK_LABELS: Readonly<Record<RunningTask, string>> = {
  test: 'Test Connection',
  autodetect: 'Autodetect',
  verify: 'Verify Mapping',
  browse: 'the remote folder picker',
};

const FIX_FIELDS = 'Fix the highlighted fields first.';
const UNEXPECTED = 'Failed because of an unexpected error. The details are in the Deployment log.';

/** The connection part of a draft: what Test Connection, Autodetect and the picker need. */
function connectionOnly(draft: SftpDraft, rootPath = draft.rootPath): SftpDraft {
  return { ...draft, rootPath, mappings: [], excludedLocalPaths: [], excludedRemotePaths: [] };
}

function isSftpStatusError(error: unknown): boolean {
  return error instanceof Error && typeof (error as Error & { code?: unknown }).code === 'number';
}

/**
 * Whether a directory reported by the server can be stored as a root path: absolute, without
 * `..` or backslashes, and without any character that would be shown escaped.
 */
function isStorableRootPath(path: string): boolean {
  return (
    path.startsWith('/') &&
    path.length <= MAX_TEXT_LENGTH &&
    !path.includes('\\') &&
    !hasInvisibleCharacters(path) &&
    !path.split('/').includes('..')
  );
}

/** Messages that start an operation on a server or a dialog; refused after dispose. */
const OPERATIONS = new Set([
  'testConnection',
  'autodetectRoot',
  'verifyMapping',
  'browseRemote',
  'remoteList',
  'pickPath',
  'pickProjectPath',
]);

type TaskState = 'running' | 'connected' | 'failed';

/** Posts the status of a task and knows whether it was left running. */
interface Reporter {
  readonly status: (state: TaskState, text: string) => void;
  readonly isRunning: () => boolean;
}

/** The base folder of a picker: `rootPath` without a trailing slash. */
function baseFolder(rootPath: string): string {
  const normalized = posix.normalize(rootPath);
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

interface Browse {
  readonly browser: RemoteBrowser;
  readonly session: ServerSession;
  /** For the log. */
  readonly serverName: string;
  /** A folder is being listed; the picker lists one at a time. */
  listing: boolean;
}

export class SettingsController {
  private readonly host: SettingsHost;
  private loaded: Loaded | undefined;
  /** Unsaved edits, or `null` when the form shows the saved servers. */
  private draft: ServerDraft[] | null;
  private changedOnDisk: boolean;
  /** The server operation that is running, at most one. */
  private task: RunningTask | null = null;
  /** The open picker; set once its server was validated. */
  private browse: Browse | null = null;
  /** A picker that is being opened (validating its server); `null` once closed. */
  private opening: object | null = null;
  /** Connections of server operations that are open, closed on dispose. */
  private readonly sessions = new Set<ServerSession>();
  /** A file or folder dialog is open. */
  private picking = false;
  /** Set once the running Save has written the file. */
  private written = false;
  private saving = false;
  private disposed = false;
  private queue: Promise<void> = Promise.resolve();

  /** `restored`: the state of a panel that was closed with unsaved changes. */
  constructor(host: SettingsHost, restored: SettingsSnapshot | null = null) {
    this.host = host;
    this.draft = restored === null ? null : [...restored.draft];
    this.loaded = restored?.loaded;
    this.changedOnDisk = restored?.changedOnDisk ?? false;
  }

  /**
   * Handles a message posted by the webview. Resolves when it has been handled (or dropped).
   */
  handle(raw: unknown): Promise<void> {
    if (exceedsSize(raw, MAX_MESSAGE_SIZE)) {
      this.warn('ignored a too large message from the settings panel');
      if (isSaveMessage(raw)) {
        // The webview waits for an answer to Save.
        this.post({ type: 'saveFailed', message: 'The settings are too large to save.' });
      }
      return Promise.resolve();
    }
    const parsed = parseWebviewMessage(raw);
    if (!parsed.ok) {
      this.warn(
        parsed.type === null
          ? 'ignored an unknown message from the settings panel'
          : `ignored an invalid "${parsed.type}" message from the settings panel`,
      );
      return Promise.resolve();
    }
    const { message } = parsed;
    if (this.disposed && OPERATIONS.has(message.type)) {
      this.warn(`ignored a "${message.type}" message of a closed settings panel`);
      return Promise.resolve();
    }
    if ((message.type === 'pickPath' || message.type === 'pickProjectPath') && this.picking) {
      this.warn(`ignored a "${message.type}" message while a dialog is open`);
      return Promise.resolve();
    }
    switch (message.type) {
      case 'testConnection':
        if (this.busy(message.type)) {
          this.post({
            type: 'testStatus',
            id: message.server.id,
            state: 'failed',
            text: this.busyText(),
          });
          return Promise.resolve();
        }
        return this.runTask('test', () => this.testConnection(message.server));
      case 'autodetectRoot':
      case 'verifyMapping': {
        const task: ServerTask = message.type === 'autodetectRoot' ? 'autodetect' : 'verify';
        const { id } = message.server;
        if (this.busy(message.type)) {
          this.post({ type: 'taskStatus', id, task, state: 'failed', text: this.busyText() });
          return Promise.resolve();
        }
        return this.runTask(task, () =>
          this.answered(id, task, (reporter) =>
            task === 'autodetect'
              ? this.autodetect(message.server, reporter)
              : this.verifyMapping(message.server, reporter),
          ),
        );
      }
      case 'browseRemote':
        if (this.busy(message.type)) {
          this.post({ type: 'remoteError', session: null, path: '', message: this.busyText() });
          return Promise.resolve();
        }
        // The picker stays open after this message: it ends with remoteClose.
        this.task = 'browse';
        return this.openBrowse(message.server, message.purpose).catch((error: unknown) => {
          this.closeBrowse();
          throw error;
        });
      case 'remoteList':
        return this.remoteList(message.session, message.path);
      case 'remoteClose':
        this.closeBrowse();
        return Promise.resolve();
      case 'pickProjectPath':
        return this.picked(() => this.pickProjectPath(message.id, message.list, message.index));
      case 'save':
        if (this.saving) {
          this.warn('ignored a "save" message while saving');
          return Promise.resolve();
        }
        this.saving = true;
        return this.enqueue(() => this.answeredSave(message.servers)).finally(() => {
          this.saving = false;
        });
      case 'pickPath':
        return this.picked(() => this.pickPath(message.id, message.field));
      default:
        return this.enqueue(() => this.dispatch(message));
    }
  }

  /** Whether the form holds edits that are not saved. */
  isDirty(): boolean {
    return this.draft !== null && !sameDrafts(this.draft, this.savedDrafts());
  }

  /** The state to restore when the panel is opened again, or `null` without unsaved edits. */
  snapshot(): SettingsSnapshot | null {
    if (!this.isDirty() || this.draft === null) {
      return null;
    }
    return { draft: [...this.draft], loaded: this.loaded, changedOnDisk: this.changedOnDisk };
  }

  /**
   * Takes over the unsaved changes of a panel that was closed, when this one has none of its
   * own. Returns whether they were taken over.
   */
  restore(snapshot: SettingsSnapshot): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.isDirty()) {
        return false;
      }
      this.draft = [...snapshot.draft];
      this.loaded = snapshot.loaded;
      this.changedOnDisk = snapshot.changedOnDisk;
      if (this.loaded !== undefined && (await this.diskDiffers())) {
        this.changedOnDisk = true;
      }
      await this.postState(null);
      return true;
    });
  }

  /** Settles when every queued message has been handled. */
  settled(): Promise<void> {
    return this.queue;
  }

  /**
   * The webview is gone: nothing is posted any more. Work in progress (a Save) still finishes.
   */
  dispose(): void {
    this.disposed = true;
    this.closeBrowse();
    for (const session of [...this.sessions]) {
      session.close();
    }
  }

  /**
   * Compares the file on disk with what the panel loaded; when it differs, the webview shows
   * that it changed (and the next Save is refused until it is reloaded).
   */
  checkDisk(): Promise<void> {
    return this.enqueue(async () => {
      if (this.loaded === undefined) {
        return;
      }
      if (await this.diskDiffers()) {
        this.changedOnDisk = true;
        this.post({ type: 'changedOnDisk' });
      }
    });
  }

  private warn(detail: string): void {
    this.host.log.warn(undefined, 'Settings', detail);
  }

  private post(message: HostMessage): void {
    if (!this.disposed) {
      this.host.post(message);
    }
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async diskDiffers(): Promise<boolean> {
    return !this.sameLoaded(describeLoad(await this.host.load()));
  }

  private async dispatch(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        if (this.loaded === undefined) {
          this.loaded = describeLoad(await this.host.load());
        } else if (await this.diskDiffers()) {
          // A webview loaded again (or a reopened panel) keeps what it was editing against.
          this.changedOnDisk = true;
        }
        await this.postState(null);
        return;
      case 'reload':
        this.loaded = describeLoad(await this.host.load());
        this.draft = null;
        this.changedOnDisk = false;
        await this.postState(null);
        return;
      case 'draft':
        this.draft = [...message.servers];
        return;
      default:
        // Save, server operations and the pickers are handled in handle().
        return;
    }
  }

  private savedDrafts(): ServerDraft[] {
    return this.loaded?.kind === 'usable' ? draftsFromConfig(this.loaded.config) : [];
  }

  private sameLoaded(other: Loaded): boolean {
    const loaded = this.loaded;
    if (loaded === undefined || loaded.kind !== other.kind) {
      return false;
    }
    if (loaded.kind === 'unusable' || other.kind === 'unusable') {
      return loaded.kind === 'unusable' && other.kind === 'unusable'
        ? loaded.problem === other.problem
        : false;
    }
    return serialize(loaded.config) === serialize(other.config);
  }

  private async projectPath(): Promise<string> {
    const config = this.loaded?.kind === 'usable' ? this.loaded.config : null;
    return config?.projectPath ?? (await this.host.projectPath());
  }

  private async aliases(): Promise<{ aliases: readonly string[]; problem: string | null }> {
    try {
      return { aliases: await this.host.listAliases(), problem: null };
    } catch (error) {
      if (error instanceof SshConfigError) {
        return {
          aliases: [],
          problem: `The SSH config could not be read: ${sanitizeForDisplay(error.message, { maxLength: 300 })}`,
        };
      }
      if (isFileSystemError(error)) {
        return { aliases: [], problem: `The SSH config could not be read (${errorCode(error)}).` };
      }
      // A bug: the panel still works with manual connections, and the log has the message.
      this.host.log.error(undefined, 'Settings: SSH config hosts (unexpected error)', error);
      return {
        aliases: [],
        problem: 'The SSH config hosts could not be listed. The details are in the Deployment log.',
      };
    }
  }

  private async postState(notice: string | null): Promise<void> {
    const loaded = this.loaded ?? describeLoad(await this.host.load());
    this.loaded = loaded;
    const saved = this.savedDrafts();
    const { aliases, problem: aliasProblem } = await this.aliases();
    this.post({
      type: 'state',
      folderName: this.host.folderName,
      saved,
      draft: loaded.kind === 'usable' && this.draft !== null ? this.draft : saved,
      aliases,
      aliasProblem,
      problem: loaded.kind === 'unusable' ? loaded.problem : null,
      changedOnDisk: this.changedOnDisk,
      notice,
      errors: [],
    });
  }

  private postErrors(errors: readonly FormError[]): void {
    this.post({ type: 'errors', errors });
  }

  private refuseChangedOnDisk(): void {
    this.post({ type: 'changedOnDisk' });
    this.postErrors([{ serverId: null, field: null, message: CHANGED_ON_DISK }]);
  }

  /**
   * Runs a Save and makes sure the webview gets an answer, so that its Save button never stays
   * disabled: `save` answers on every path it returns from; when it throws, the answer says
   * whether the file was written, and the error is passed on.
   */
  private async answeredSave(servers: readonly ServerDraft[]): Promise<void> {
    this.written = false;
    try {
      await this.save(servers);
    } catch (error) {
      this.post(
        this.hasWritten()
          ? { type: 'saved' }
          : {
              type: 'saveFailed',
              message:
                'The configuration was not saved because of an unexpected error. The details are in the Deployment log.',
            },
      );
      throw error;
    }
  }

  /** Whether the running Save has written the file (set inside `save`). */
  private hasWritten(): boolean {
    return this.written;
  }

  private async save(servers: readonly ServerDraft[]): Promise<void> {
    this.draft = [...servers];
    const loaded = this.loaded;
    if (loaded?.kind !== 'usable') {
      this.postErrors([
        {
          serverId: null,
          field: null,
          message:
            loaded?.kind === 'unusable' ? loaded.problem : 'The configuration is not loaded yet.',
        },
      ]);
      return;
    }
    if (this.changedOnDisk) {
      this.refuseChangedOnDisk();
      return;
    }
    const stored = loaded.config?.servers ?? [];
    const built = buildConfig(await this.projectPath(), servers, stored, {
      platform: this.host.platform,
    });
    if (!built.ok) {
      this.postErrors(built.errors);
      return;
    }
    try {
      await this.host.save(built.config, loaded.config);
    } catch (error) {
      if (error instanceof ConfigChangedError) {
        this.changedOnDisk = true;
        this.refuseChangedOnDisk();
        return;
      }
      if (
        error instanceof UnsafeConfigError ||
        error instanceof UnownedConfigError ||
        error instanceof InvalidConfigError
      ) {
        this.host.log.error(undefined, 'Settings: save', error);
        this.postErrors([{ serverId: null, field: null, message: error.message }]);
        return;
      }
      if (isFileSystemError(error)) {
        this.host.log.error(undefined, 'Settings: save', error);
        this.postErrors([
          {
            serverId: null,
            field: null,
            message: `The configuration could not be saved (${errorCode(error)}).`,
          },
        ]);
        return;
      }
      throw error;
    }
    this.written = true;
    const kept = new Set(built.config.servers.map((server) => server.id));
    for (const server of stored) {
      if (!kept.has(server.id)) {
        this.host.disconnect(server.id);
      }
    }
    this.host.log.info(undefined, 'Settings', `saved the configuration of ${this.host.folderName}`);
    this.loaded = { kind: 'usable', config: built.config };
    this.draft = null;
    this.changedOnDisk = false;
    this.host.onSaved();
    await this.reloadAfterSave();
    await this.postState('Saved.');
  }

  /**
   * Reads the file again after a save, so that the panel shows what is on disk. The file was
   * written either way: when reading it fails, the panel keeps what it wrote (and says Saved);
   * the next disk check compares against that.
   */
  private async reloadAfterSave(): Promise<void> {
    let result: LoadResult;
    try {
      result = await this.host.load();
    } catch (error) {
      this.host.log.error(undefined, 'Settings: reading the saved configuration', error);
      return;
    }
    this.loaded = describeLoad(result);
  }

  /** The picker waits for the user outside the queue; the chosen path is applied in order. */
  private async pickPath(id: string, field: PathField): Promise<void> {
    const server = (this.draft ?? this.savedDrafts()).find((candidate) => candidate.id === id);
    let current = '';
    if (server?.type === 'sftp' && field === 'identityFile') {
      current = server.identityFile;
    } else if (server?.type === 'inplace' && field === 'folder') {
      current = server.folder;
    }
    const path = await this.host.pickPath(field, current);
    if (path === undefined) {
      return;
    }
    await this.applyPicked(id, field, path);
  }

  /** Puts a picked value into the form; kept here too, so that it survives a reload. */
  private applyPicked(id: string, field: PickedField, path: string): Promise<void> {
    return this.enqueue(() => {
      this.updateDraft(id, (candidate) => {
        if (candidate.type === 'sftp' && (field === 'identityFile' || field === 'rootPath')) {
          return { ...candidate, [field]: path };
        }
        if (candidate.type === 'inplace' && field === 'folder') {
          return { ...candidate, folder: path };
        }
        return candidate;
      });
      this.post({ type: 'picked', id, field, path });
      return Promise.resolve();
    });
  }

  private updateDraft(id: string, change: (server: ServerDraft) => ServerDraft): void {
    this.draft = (this.draft ?? this.savedDrafts()).map((candidate) =>
      candidate.id === id ? change(candidate) : candidate,
    );
  }

  private async pickProjectPath(id: string, list: LocalList, index: number): Promise<void> {
    const server = (this.draft ?? this.savedDrafts()).find((candidate) => candidate.id === id);
    if (server?.type !== 'sftp') {
      this.warn('ignored a "pickProjectPath" message for a server that is not in the form');
      return;
    }
    const current =
      list === 'mappings' ? server.mappings[index]?.localPath : server.excludedLocalPaths[index];
    const picked = await this.host.pickProjectPath(
      list,
      current === undefined || current.trim() === '' ? null : current.trim(),
    );
    if (picked === undefined) {
      return;
    }
    const relative = projectRelativePath(await this.projectPath(), picked, this.host.platform);
    if (relative === '.' && list === 'excludedLocalPaths') {
      this.post({
        type: 'problem',
        message: 'The project folder itself cannot be excluded. Select a file or folder inside it.',
      });
      return;
    }
    if (relative === null) {
      this.post({
        type: 'problem',
        message:
          'The selected path is not inside the project folder (symbolic links are resolved), so it cannot be used.',
      });
      return;
    }
    await this.enqueue(() => {
      this.updateDraft(id, (candidate) => {
        if (candidate.type !== 'sftp') {
          return candidate;
        }
        if (list === 'mappings') {
          const row = candidate.mappings[index];
          if (row === undefined) {
            return candidate;
          }
          const mappings = candidate.mappings.with(index, { ...row, localPath: relative });
          return { ...candidate, mappings };
        }
        if (index >= candidate.excludedLocalPaths.length) {
          return candidate;
        }
        return {
          ...candidate,
          excludedLocalPaths: candidate.excludedLocalPaths.with(index, relative),
        };
      });
      this.post({ type: 'pickedItem', id, list, index, path: relative });
      return Promise.resolve();
    });
  }

  /** Whether a server operation is running; a second one would only queue another prompt. */
  private busy(type: string): boolean {
    if (this.task === null) {
      return false;
    }
    this.warn(`ignored a "${type}" message while ${TASK_LABELS[this.task]} is running`);
    return true;
  }

  private busyText(): string {
    switch (this.task) {
      case 'test':
        return 'Another Test Connection is running.';
      case 'browse':
        return 'Close the remote folder picker first.';
      default:
        return `Wait until ${TASK_LABELS[this.task ?? 'test']} has finished.`;
    }
  }

  private async runTask(task: RunningTask, work: () => Promise<void>): Promise<void> {
    this.task = task;
    try {
      await work();
    } finally {
      if (this.task === task) {
        this.task = null;
      }
    }
  }

  /** One dialog at a time. */
  private async picked(work: () => Promise<void>): Promise<void> {
    this.picking = true;
    try {
      await work();
    } finally {
      this.picking = false;
    }
  }

  /**
   * Runs a task so that the webview always gets a final status: when the task throws while its
   * status is still running, it is answered as failed (and the error is passed on).
   */
  private async answered(
    id: string,
    task: ServerTask,
    work: (reporter: Reporter) => Promise<void>,
  ): Promise<void> {
    let running = false;
    const reporter: Reporter = {
      status: (state, text) => {
        running = state === 'running';
        this.post({ type: 'taskStatus', id, task, state, text });
      },
      isRunning: () => running,
    };
    try {
      await work(reporter);
    } finally {
      if (reporter.isRunning()) {
        reporter.status('failed', UNEXPECTED);
      }
    }
  }

  /** A connection for a server operation; closed by the caller, or on dispose. */
  private openSession(server: SftpServer): ServerSession {
    if (this.disposed) {
      throw new ConnectionError('The settings panel was closed.');
    }
    const session = this.host.openSession(server);
    const tracked: ServerSession = {
      run: (operation) => session.run(operation),
      close: () => {
        this.sessions.delete(tracked);
        session.close();
      },
    };
    this.sessions.add(tracked);
    return tracked;
  }

  /**
   * The server of a draft, validated, for a server operation; posts the errors and `null` when
   * it is not valid.
   */
  private async serverFor(draft: SftpDraft): Promise<SftpServer | null> {
    const stored = this.loaded?.kind === 'usable' ? (this.loaded.config?.servers ?? []) : [];
    const result = sftpServerFromDraft(await this.projectPath(), draft, stored, {
      platform: this.host.platform,
    });
    if (!result.ok) {
      this.postErrors(result.errors);
      return null;
    }
    return result.server;
  }

  /**
   * The text for a failed server operation. Expected failures are logged and shown with their
   * (sanitized) message; anything else is a bug and is passed on after the webview was told.
   */
  private failureText(
    serverName: string,
    what: string,
    error: unknown,
    report: (text: string) => void,
  ): string {
    const failure = connectionFailure(error);
    if (failure === undefined) {
      report(UNEXPECTED);
      throw error;
    }
    if (failure.kind === 'cancelled') {
      this.host.log.info(serverName, what, 'cancelled');
      return 'Cancelled.';
    }
    this.host.log.error(serverName, what, error);
    return sanitizeForDisplay(failure.message, { maxLength: 500 });
  }

  private async autodetect(draft: SftpDraft, reporter: Reporter): Promise<void> {
    const { id } = draft;
    const { status } = reporter;
    // The root path is what is detected; any absolute path makes the draft valid meanwhile.
    const server = await this.serverFor(connectionOnly(draft, '/'));
    if (server === null) {
      status('failed', FIX_FIELDS);
      return;
    }
    status('running', 'Connecting…');
    const session = this.openSession(server);
    let home: string;
    try {
      home = await session.run((target) => target.realpath('.'));
    } catch (error) {
      status(
        'failed',
        this.failureText(server.name, 'Autodetect', error, (text) => {
          status('failed', text);
        }),
      );
      return;
    } finally {
      session.close();
    }
    const shown = sanitizeForDisplay(home, { maxLength: 500 });
    if (!isStorableRootPath(home)) {
      status('failed', `The home directory on the server cannot be used as root path: ${shown}`);
      return;
    }
    this.host.log.info(server.name, 'Autodetect', `home directory ${home}`);
    await this.applyPicked(id, 'rootPath', home);
    const before = draft.rootPath.trim();
    status(
      'connected',
      before !== '' && before !== home
        ? `Root path changed from ${sanitizeForDisplay(before, { maxLength: 500 })} to ${shown}`
        : `Root path set to the home directory: ${shown}`,
    );
  }

  private async verifyMapping(draft: SftpDraft, reporter: Reporter): Promise<void> {
    const { id } = draft;
    const { status } = reporter;
    const server = await this.serverFor(draft);
    if (server === null) {
      status('failed', FIX_FIELDS);
      return;
    }
    if (server.mappings.length === 0) {
      status('failed', 'Add a mapping first.');
      return;
    }
    status('running', 'Listing the project files…');
    const project = await this.host.listProjectFiles();
    const plans = planVerification(server, project.files, VERIFY_SAMPLE_SIZE, this.host.random);
    const total = plans.reduce((sum, plan) => sum + plan.files.length, 0);
    if (total === 0) {
      // Nothing to look up: no connection, and never a result that looks like success.
      const checks = await verifyMappings(
        { stat: () => Promise.reject(new Error('Nothing should be looked up.')) },
        plans,
      );
      this.postVerifyResult(id, project, checks);
      const mapped = plans.reduce((sum, plan) => sum + plan.mapped, 0);
      let reason: string;
      if (project.files.length === 0) {
        reason = 'No project files were found';
      } else if (mapped > 0) {
        reason = 'All project files of the mappings are excluded';
      } else {
        reason = 'No project file is inside a mapping';
      }
      status('failed', `${reason}, so nothing was checked.`);
      return;
    }
    status('running', `Looking up ${total} files on the server…`);
    const session = this.openSession(server);
    let checks: Awaited<ReturnType<typeof verifyMappings>>;
    try {
      checks = await session.run((target) => verifyMappings(target, plans));
    } catch (error) {
      status(
        'failed',
        this.failureText(server.name, 'Verify Mapping', error, (text) => {
          status('failed', text);
        }),
      );
      return;
    } finally {
      session.close();
    }
    this.postVerifyResult(id, project, checks);
    const found = checks.reduce((sum, check) => sum + check.found, 0);
    const checked = checks.reduce((sum, check) => sum + check.checked, 0);
    const unchecked = checks.reduce((sum, check) => sum + check.unchecked.length, 0);
    const summary =
      `${found}/${checked} files found.` +
      (unchecked === 0 ? '' : ` ${unchecked} could not be checked.`);
    this.host.log.info(server.name, 'Verify Mapping', summary);
    status(overallPassed(checks) ? 'connected' : 'failed', summary);
  }

  private postVerifyResult(
    id: string,
    project: ProjectFiles,
    checks: Awaited<ReturnType<typeof verifyMappings>>,
  ): void {
    const shown = (text: string): string => sanitizeForDisplay(text, { maxLength: 300 });
    this.post({
      type: 'verifyResult',
      id,
      source: project.source,
      truncated: project.truncated,
      checks: checks.map((check) => ({
        localPath: shown(check.localPath),
        deploymentPath: shown(check.deploymentPath),
        checked: check.checked,
        found: check.found,
        verdict: check.verdict,
        text: verdictText(check),
        missing: check.missing.map(shown),
        unchecked: check.unchecked.map((file) => ({
          path: shown(file.local),
          reason: shown(file.reason),
        })),
      })),
    });
  }

  /** Opens the remote folder picker and lists its base folder. */
  private async openBrowse(draft: SftpDraft, purpose: BrowsePurpose): Promise<void> {
    const error = (message: string): void => {
      this.post({ type: 'remoteError', session: null, path: '', message });
    };
    const opening = {};
    this.opening = opening;
    const server = await this.serverFor(
      connectionOnly(draft, purpose === 'rootPath' ? '/' : draft.rootPath),
    );
    if (this.opening !== opening) {
      // Closed (Cancel) while the server was checked: nothing is opened.
      return;
    }
    this.opening = null;
    if (server === null) {
      this.task = null;
      error(FIX_FIELDS);
      return;
    }
    const base = purpose === 'rootPath' ? '/' : baseFolder(server.rootPath);
    const browse: Browse = {
      browser: new RemoteBrowser(base, randomBytes(16).toString('hex')),
      session: this.openSession(server),
      serverName: server.name,
      listing: false,
    };
    this.browse = browse;
    await this.listFolder(browse, '');
  }

  private async remoteList(session: string, path: string): Promise<void> {
    const browse = this.browse;
    if (browse === null || browse.browser.session !== session) {
      // The connection was lost (or the picker closed): the webview stops the tree.
      this.warn('refused a "remoteList" message of a picker that is closed');
      this.post({
        type: 'remoteError',
        session: null,
        path,
        message: 'The connection of the folder picker was closed. Close it and open it again.',
      });
      return;
    }
    await this.listFolder(browse, path);
  }

  private async listFolder(browse: Browse, path: string): Promise<void> {
    const { browser } = browse;
    const absolute = browser.folderPath(path);
    if (absolute === null) {
      this.warn('refused to list a remote folder the picker did not offer');
      this.post({
        type: 'remoteError',
        session: browser.session,
        path,
        message: 'This folder cannot be opened.',
      });
      return;
    }
    if (browse.listing) {
      this.post({
        type: 'remoteError',
        session: browser.session,
        path,
        message: 'Another folder is being listed. Open this one again afterwards.',
      });
      return;
    }
    browse.listing = true;
    let listing: Awaited<ReturnType<DeploymentTarget['readdir']>>;
    try {
      listing = await browse.session.run((target) => target.readdir(absolute, MAX_REMOTE_ENTRIES));
    } catch (error) {
      if (this.browse !== browse) {
        // Closed meanwhile (Cancel while connecting): nobody waits for the answer.
        return;
      }
      const keep = isSftpStatusError(error);
      const report = (message: string): void => {
        if (!keep) {
          this.closeBrowse();
        }
        this.post({
          type: 'remoteError',
          session: keep ? browser.session : null,
          path,
          message,
        });
      };
      report(this.failureText(browse.serverName, 'Remote folder picker', error, report));
      return;
    } finally {
      browse.listing = false;
    }
    if (this.browse !== browse) {
      return;
    }
    this.post({
      type: 'remoteListing',
      session: browser.session,
      base: sanitizeForDisplay(browser.base, { maxLength: 500 }),
      path,
      entries: browser.record(path, listing),
      truncated: listing.truncated,
    });
  }

  /** Closes the picker and its connection, if one is open. */
  private closeBrowse(): void {
    const browse = this.browse;
    const wasOpen = browse !== null || this.opening !== null;
    this.browse = null;
    this.opening = null;
    browse?.session.close();
    if (wasOpen && this.task === 'browse') {
      this.task = null;
    }
  }

  private async testConnection(draft: SftpDraft): Promise<void> {
    const { id } = draft;
    const stored = this.loaded?.kind === 'usable' ? (this.loaded.config?.servers ?? []) : [];
    // Only the connection settings matter here; a mapping being edited does not stop the test.
    const result = sftpServerFromDraft(await this.projectPath(), connectionOnly(draft), stored, {
      platform: this.host.platform,
    });
    if (!result.ok) {
      this.postErrors(result.errors);
      this.post({
        type: 'testStatus',
        id,
        state: 'failed',
        text: 'Fix the highlighted fields first.',
      });
      return;
    }
    this.post({ type: 'testStatus', id, state: 'running', text: 'Connecting…' });
    const outcome = await this.host.testConnection(result.server);
    this.post(
      outcome === undefined
        ? {
            type: 'testStatus',
            id,
            state: 'failed',
            text: 'Not connected. The details are in the notification and the Deployment log.',
          }
        : {
            type: 'testStatus',
            id,
            state: 'connected',
            text: `Connected as ${outcome.user}. Home directory: ${outcome.home}`,
          },
    );
  }
}
