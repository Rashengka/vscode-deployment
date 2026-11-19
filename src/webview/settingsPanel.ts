/**
 * The settings webview panels: at most one per workspace folder. This file connects the panel
 * to VS Code (webview, dialogs, file watcher, connection manager); what the panel does is in
 * `src/settings/controller.ts`.
 *
 * The webview is locked down: scripts only with the nonce of its document, no forms, no command
 * links, and local resources only from `dist/webview`. It never receives a secret.
 */
import { randomInt } from 'node:crypto';
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { testConnectionHost } from '../commands/connectionCommands';
import { watchSpec } from '../config/folders';
import { CONFIG_FILE_NAME, type DeploymentConfig } from '../config/model';
import {
  canonicalProjectPath,
  loadConfig,
  saveConfig,
  type LoadResult,
  type StoreOptions,
} from '../config/store';
import { sanitizeForDisplay } from '../display/sanitize';
import type { DeploymentLog } from '../log/deploymentLog';
import { projectRelativePath } from '../mapping/paths';
import {
  collectProjectFiles,
  findExecutable,
  gitLsFiles,
  type ProjectFiles,
} from '../mapping/projectFiles';
import {
  SettingsController,
  type SettingsHost,
  type SettingsSnapshot,
} from '../settings/controller';
import { discardPrompt, discardsChanges } from '../settings/discardPrompt';
import { createNonce, settingsHtml } from '../settings/html';
import type { HostMessage, LocalList, PathField } from '../settings/protocol';
import { UnsavedServerSession, testUnsavedServer } from '../settings/testUnsavedServer';
import type { ConnectionManager } from '../ssh/connectionManager';
import { listSshHostAliases } from '../ssh/sshConfig';
import { nodeFileAccess } from '../ssh/sshConfigFiles';
import { connectionKey } from '../ui/serverChoices';

export const OPEN_SETTINGS_COMMAND = 'vscodeDeployment.openSettings';
const VIEW_TYPE = 'vscodeDeployment.settings';

/** Delay that merges the bursts of events a single save produces. */
const DISK_CHECK_DELAY_MS = 150;
/** Messages kept for {@link SettingsPanelHandle.posted}. */
const POSTED_KEPT = 50;

export interface SettingsPanelsOptions {
  readonly extensionUri: vscode.Uri;
  readonly storeOptions: () => StoreOptions;
  readonly connections: ConnectionManager;
  readonly log: DeploymentLog;
  readonly showLog: () => void;
  /** Called after the panel saved a configuration. */
  readonly onSaved: () => void;
}

/**
 * What the Open Settings command returns: the panel of the folder, for the extension tests.
 * `receive` takes a message exactly as if the webview had posted it (it is validated the same
 * way), so it gives no more access than the webview has.
 */
export interface SettingsPanelHandle {
  readonly folderKey: string;
  /** The HTML document of the webview. */
  html(): string;
  /** Settles when the webview's script has started and asked for its state. */
  whenReady(): Promise<void>;
  receive(message: unknown): Promise<void>;
  /** The last messages sent to the webview. */
  posted(): readonly HostMessage[];
  isDirty(): boolean;
}

class SettingsPanel implements SettingsPanelHandle {
  readonly folderKey: string;
  readonly panel: vscode.WebviewPanel;
  private readonly controller: SettingsController;
  private readonly folder: vscode.WorkspaceFolder;
  private readonly options: SettingsPanelsOptions;
  private readonly sent: HostMessage[] = [];
  private readonly ready: Promise<void>;
  private markReady: () => void = () => undefined;
  private configDir: string | null = null;
  private watcher: { key: string; watcher: vscode.FileSystemWatcher } | undefined;
  private diskTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    folder: vscode.WorkspaceFolder,
    options: SettingsPanelsOptions,
    restored: SettingsSnapshot | null,
  ) {
    this.folder = folder;
    this.options = options;
    this.folderKey = folder.uri.toString();
    this.ready = new Promise((resolve) => {
      this.markReady = resolve;
    });
    const webviewRoot = vscode.Uri.joinPath(options.extensionUri, 'dist', 'webview');
    this.panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      `Deployment: ${sanitizeForDisplay(folder.name, { maxLength: 80 })}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        enableForms: false,
        enableCommandUris: false,
        localResourceRoots: [webviewRoot],
        enableFindWidget: false,
        retainContextWhenHidden: false,
      },
    );
    const { webview } = this.panel;
    webview.html = settingsHtml({
      cspSource: webview.cspSource,
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, 'main.js')).toString(),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, 'style.css')).toString(),
      nonce: createNonce(),
    });
    this.controller = new SettingsController(this.host(), restored);
    this.disposables.push(
      webview.onDidReceiveMessage((message: unknown) => {
        if (isReady(message)) {
          this.markReady();
        }
        void this.receive(message);
      }),
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) {
          this.scheduleDiskCheck();
        }
      }),
    );
  }

  html(): string {
    return this.panel.webview.html;
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  posted(): readonly HostMessage[] {
    return [...this.sent];
  }

  isDirty(): boolean {
    return this.controller.isDirty();
  }

  receive(message: unknown): Promise<void> {
    return this.guarded(this.controller.handle(message));
  }

  /**
   * Takes over the unsaved changes of a closed panel; when this one has unsaved changes of its
   * own, they win and the user is told.
   */
  async restore(snapshot: SettingsSnapshot): Promise<void> {
    const restored = await this.controller.restore(snapshot).catch((error: unknown) => {
      this.reportUnexpected(error);
      return true;
    });
    if (!restored) {
      void vscode.window.showWarningMessage(
        'Your earlier unsaved changes could not be restored because the settings are open again.',
      );
    }
  }

  /**
   * The panel was closed: posts stop, and the result is what to restore when it is opened
   * again (after work in progress, such as a Save, has finished), or `null`.
   */
  async closed(): Promise<SettingsSnapshot | null> {
    this.controller.dispose();
    await this.guarded(this.controller.settled());
    return this.controller.snapshot();
  }

  /** An unexpected error is a bug: it is logged (message only) and shown without detail. */
  private async guarded(work: Promise<void>): Promise<void> {
    await work.catch((error: unknown) => {
      this.reportUnexpected(error);
    });
  }

  private reportUnexpected(error: unknown): void {
    this.options.log.error(undefined, 'Settings (unexpected error)', error);
    void vscode.window.showErrorMessage(
      'The deployment settings failed because of an unexpected error. The details are in the Deployment log.',
    );
  }

  private scheduleDiskCheck(): void {
    if (this.diskTimer !== undefined) {
      clearTimeout(this.diskTimer);
    }
    this.diskTimer = setTimeout(() => {
      this.diskTimer = undefined;
      void this.guarded(this.controller.checkDisk());
    }, DISK_CHECK_DELAY_MS);
  }

  /** Watches the configuration file of the folder (also before it exists). */
  private watch(dir: string | null): void {
    this.configDir = dir;
    const spec = dir === null ? null : watchSpec(dir, existsSync);
    const key = spec === null ? '' : `${spec.base}\n${spec.pattern}`;
    if (this.watcher?.key === key) {
      return;
    }
    this.watcher?.watcher.dispose();
    this.watcher = undefined;
    if (spec === null) {
      return;
    }
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(spec.base), spec.pattern),
    );
    const onEvent = (): void => {
      this.scheduleDiskCheck();
    };
    watcher.onDidCreate(onEvent);
    watcher.onDidChange(onEvent);
    watcher.onDidDelete(onEvent);
    this.watcher = { key, watcher };
  }

  private host(): SettingsHost {
    const { options, folder } = this;
    const fsPath = folder.uri.fsPath;
    const load = async (): Promise<LoadResult> => {
      const result = await loadConfig(fsPath, options.storeOptions());
      this.watch(result.status === 'unsafe' ? null : result.dir);
      return result;
    };
    return {
      folderName: sanitizeForDisplay(folder.name, { maxLength: 200 }),
      platform: process.platform,
      log: options.log,
      post: (message) => {
        this.sent.push(message);
        this.sent.splice(0, Math.max(0, this.sent.length - POSTED_KEPT));
        void this.panel.webview.postMessage(message);
      },
      load,
      projectPath: () => canonicalProjectPath(fsPath),
      save: async (config: DeploymentConfig, expected: DeploymentConfig | null) => {
        const write = async (): Promise<void> => {
          await saveConfig(fsPath, config, options.storeOptions(), { expected });
        };
        if (this.configDir === null) {
          await write();
          return;
        }
        // Tells the connection manager that this change of config.json is the extension's own.
        await options.connections.writeConfiguration(
          join(this.configDir, CONFIG_FILE_NAME),
          async () => {
            await write();
            return config.servers.filter((server) => server.type === 'sftp');
          },
        );
      },
      listAliases: () =>
        listSshHostAliases({
          homeDirectory: homedir(),
          localUser: userInfo().username,
          ...nodeFileAccess,
        }),
      pickPath: (field, current) => pickPath(field, current),
      testConnection: async (server) => {
        const configFile =
          this.configDir === null ? undefined : join(this.configDir, CONFIG_FILE_NAME);
        if (configFile === undefined) {
          void vscode.window.showErrorMessage(
            'Test Connection needs a usable deployment configuration folder.',
          );
          return undefined;
        }
        return testUnsavedServer(
          testConnectionHost(options.connections, options.log, options.showLog),
          {
            key: connectionKey(this.folderKey, server.id),
            server,
            folderName: folder.name,
            configFile,
          },
        );
      },
      disconnect: (serverId) => {
        options.connections.disconnect(connectionKey(this.folderKey, serverId));
      },
      onSaved: options.onSaved,
      pickProjectPath: (list, current) => pickProjectPath(folder, list, current),
      openSession: (server) =>
        new UnsavedServerSession(options.connections, {
          key: connectionKey(this.folderKey, server.id),
          server,
          configFile: this.configDir === null ? undefined : join(this.configDir, CONFIG_FILE_NAME),
        }),
      listProjectFiles: () => listProjectFiles(folder, options.log),
      random: (max) => randomInt(max),
    };
  }

  dispose(): void {
    if (this.diskTimer !== undefined) {
      clearTimeout(this.diskTimer);
    }
    this.watcher?.watcher.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

function isReady(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'ready'
  );
}

async function pickPath(field: PathField, current: string): Promise<string | undefined> {
  const fallback = field === 'identityFile' ? join(homedir(), '.ssh') : undefined;
  const start = current !== '' ? current : fallback;
  // Only the chosen path is used; the file itself is never read here.
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: field === 'identityFile',
    canSelectFolders: field === 'folder',
    canSelectMany: false,
    title: field === 'identityFile' ? 'Select the private key file' : 'Select the folder',
    openLabel: 'Select',
    ...(start === undefined ? {} : { defaultUri: vscode.Uri.file(start) }),
  });
  return picked?.[0]?.fsPath;
}

/**
 * A folder (mappings) or a file or folder (exclusions) in the project; the result has its
 * symbolic links resolved, so that the caller can check that it is really inside the project.
 */
async function pickProjectPath(
  folder: vscode.WorkspaceFolder,
  list: LocalList,
  current: string | null,
): Promise<string | undefined> {
  const start =
    current === null ? folder.uri : vscode.Uri.joinPath(folder.uri, ...current.split('/'));
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: list === 'excludedLocalPaths',
    canSelectFolders: true,
    canSelectMany: false,
    title:
      list === 'mappings'
        ? 'Select the local folder of the mapping'
        : 'Select the file or folder to exclude',
    openLabel: 'Select',
    defaultUri: start,
  });
  const path = picked?.[0]?.fsPath;
  if (path === undefined) {
    return undefined;
  }
  try {
    return await realpath(path);
  } catch (error) {
    if (error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string') {
      const code = sanitizeForDisplay(String((error as NodeJS.ErrnoException).code), {
        maxLength: 40,
      });
      void vscode.window.showErrorMessage(`The selected path could not be resolved (${code}).`);
      return undefined;
    }
    throw error;
  }
}

function isExecutableFile(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch (error) {
    if (error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string') {
      // Missing, not executable or not readable: not a candidate.
      return false;
    }
    throw error;
  }
}

/** The canonical path, or `undefined` when it does not exist or cannot be read. */
function canonical(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch (error) {
    if (error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string') {
      return undefined;
    }
    throw error;
  }
}

/** The project files for Verify Mapping (see `collectProjectFiles`). */
function listProjectFiles(
  folder: vscode.WorkspaceFolder,
  log: DeploymentLog,
): Promise<ProjectFiles> {
  const root = folder.uri.fsPath;
  const { platform } = process;
  return collectProjectFiles({
    trusted: vscode.workspace.isTrusted,
    findGit: () =>
      findExecutable('git', process.env['PATH'], {
        platform,
        projectRoot: root,
        realpath: canonical,
        isExecutableFile,
      }),
    gitLsFiles: (git) => gitLsFiles(git, root, process.env),
    findFiles: async (include, exclude, maxResults) => {
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, include),
        exclude,
        maxResults,
      );
      return uris
        .map((uri) => projectRelativePath(root, uri.fsPath, platform))
        .filter((path): path is string => path !== null && path !== '.');
    },
    log: (message) => {
      log.info(undefined, 'Verify Mapping', message);
    },
  });
}

/** All settings panels of the window. */
export class SettingsPanels implements vscode.Disposable {
  private readonly panels = new Map<string, SettingsPanel>();
  private readonly options: SettingsPanelsOptions;
  private disposed = false;

  constructor(options: SettingsPanelsOptions) {
    this.options = options;
  }

  /** Shows the panel of `folder`, creating it when there is none. */
  open(
    folder: vscode.WorkspaceFolder,
    restored: SettingsSnapshot | null = null,
  ): SettingsPanelHandle {
    const key = folder.uri.toString();
    const existing = this.panels.get(key);
    if (existing !== undefined) {
      existing.panel.reveal();
      if (restored !== null) {
        void existing.restore(restored);
      }
      return existing;
    }
    const panel = new SettingsPanel(folder, this.options, restored);
    this.panels.set(key, panel);
    panel.panel.onDidDispose(() => {
      this.panels.delete(key);
      void panel.closed().then((unsaved) => {
        panel.dispose();
        if (unsaved !== null && !this.disposed) {
          void this.confirmDiscard(folder, unsaved);
        }
      });
    });
    return panel;
  }

  /**
   * A webview panel cannot refuse to close, so closing it with unsaved changes asks afterwards:
   * Keep Editing (the default, also what Escape and Cancel do) opens the panel again with the
   * changes, against the configuration they were made for: a change on disk meanwhile is then
   * shown, never overwritten.
   */
  private async confirmDiscard(
    folder: vscode.WorkspaceFolder,
    unsaved: SettingsSnapshot,
  ): Promise<void> {
    const prompt = discardPrompt(folder.name);
    const answer = await vscode.window.showWarningMessage(
      prompt.message,
      prompt.options,
      ...prompt.items,
    );
    if (!discardsChanges(prompt, answer) && !this.disposed) {
      this.open(folder, unsaved);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const panel of [...this.panels.values()]) {
      panel.panel.dispose();
    }
    this.panels.clear();
  }
}
