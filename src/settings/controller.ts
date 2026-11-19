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
 * - Test Connection runs in the extension host with the unsaved form; the passphrase prompt
 *   stays there too. At most one runs per panel.
 * - Messages are handled one after another, except Test Connection and the file picker, which
 *   wait for the user. A message that is too large is dropped before it is looked at.
 */
import type { DeploymentConfig, SftpServer } from '../config/model';
import {
  ConfigChangedError,
  InvalidConfigError,
  UnownedConfigError,
  UnsafeConfigError,
  type LoadResult,
} from '../config/store';
import { sanitizeForDisplay } from '../display/sanitize';
import type { DeploymentLog } from '../log/deploymentLog';
import { SshConfigError } from '../ssh/sshConfig';
import type { TestConnectionResult } from '../ui/testConnectionFlow';
import { sameDrafts, type ServerDraft, type SftpDraft } from './draft';
import {
  MAX_MESSAGE_SIZE,
  exceedsSize,
  parseWebviewMessage,
  type FormError,
  type HostMessage,
  type PathField,
  type WebviewMessage,
} from './protocol';
import { buildConfig, draftsFromConfig, sftpServerFromDraft } from './save';

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

export class SettingsController {
  private readonly host: SettingsHost;
  private loaded: Loaded | undefined;
  /** Unsaved edits, or `null` when the form shows the saved servers. */
  private draft: ServerDraft[] | null;
  private changedOnDisk: boolean;
  private testRunning = false;
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
    switch (message.type) {
      case 'testConnection':
        if (this.testRunning) {
          // A second one would only queue another passphrase prompt.
          this.warn('ignored a "testConnection" message while Test Connection is running');
          this.post({
            type: 'testStatus',
            id: message.server.id,
            state: 'failed',
            text: 'Another Test Connection is running.',
          });
          return Promise.resolve();
        }
        this.testRunning = true;
        return this.testConnection(message.server).finally(() => {
          this.testRunning = false;
        });
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
        return this.pickPath(message.id, message.field);
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
        // Save, Test Connection and the picker are handled in handle().
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
    await this.enqueue(() => {
      // Kept here too, so that the path survives a reload of the webview or closing the panel.
      this.draft = (this.draft ?? this.savedDrafts()).map((candidate) => {
        if (candidate.id !== id) {
          return candidate;
        }
        if (candidate.type === 'sftp' && field === 'identityFile') {
          return { ...candidate, identityFile: path };
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

  private async testConnection(draft: SftpDraft): Promise<void> {
    const { id } = draft;
    const stored = this.loaded?.kind === 'usable' ? (this.loaded.config?.servers ?? []) : [];
    const result = sftpServerFromDraft(await this.projectPath(), draft, stored, {
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
