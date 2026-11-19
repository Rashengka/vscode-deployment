import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { createConnectionManager } from './adapters/connection';
import { registerConnectionCommands } from './commands/connectionCommands';
import { OPEN_CONFIG_COMMAND, openConfig } from './commands/openConfig';
import { openSettings } from './commands/openSettings';
import { CONTEXT_HAS_CONFIG, CONTEXT_HAS_UPLOAD_TARGET } from './config/contextKeys';
import {
  NotificationDeduplicator,
  describeProblem,
  loadFolders,
  watchSpec,
  type FolderRef,
  type FoldersSnapshot,
} from './config/folders';
import { configRoot } from './config/paths';
import type { StoreOptions } from './config/store';
import { DeploymentLog } from './log/deploymentLog';
import { ConnectionStates, describeDisconnect } from './ui/connectionPresentation';
import { configuredSftpServers } from './ui/serverChoices';
import { ConnectionStatusBar } from './ui/statusBar';
import { OPEN_SETTINGS_COMMAND, SettingsPanels } from './webview/settingsPanel';

/** Delay that merges the bursts of events a single save produces. */
const REFRESH_DELAY_MS = 150;

const NO_FOLDERS: FoldersSnapshot = {
  statuses: [],
  keys: { hasConfig: false, hasUploadTarget: false },
  configDirs: [],
};

function storeOptions(): StoreOptions {
  // Read on every use, so that the location always follows the current environment.
  return { root: configRoot({ platform: process.platform, env: process.env, homedir: homedir() }) };
}

/** The local workspace folders, in the form the configuration loader takes. */
function workspaceFolderRefs(): FolderRef[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === 'file')
    .map((folder) => ({
      key: folder.uri.toString(),
      name: folder.name,
      fsPath: folder.uri.fsPath,
    }));
}

/**
 * Keeps the context keys in sync with the configuration files of all workspace folders,
 * including files created or edited in another window, and warns once about each unusable
 * configuration.
 */
class ConfigTracker implements vscode.Disposable {
  private readonly watchers = new Map<string, vscode.FileSystemWatcher>();
  private readonly notifications = new NotificationDeduplicator();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> = Promise.resolve();
  private readonly onKeys: (keys: FoldersSnapshot['keys']) => void;

  constructor(onKeys: (keys: FoldersSnapshot['keys']) => void) {
    this.onKeys = onKeys;
  }

  /** Schedules a reload; several calls in quick succession cause a single reload. */
  schedule(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, REFRESH_DELAY_MS);
  }

  /** Reloads every folder now. Reloads never overlap. */
  refresh(): Promise<void> {
    this.running = this.running.then(() => this.reload());
    return this.running;
  }

  private async reload(): Promise<void> {
    let snapshot = NO_FOLDERS;
    let failure: string | null = null;
    try {
      snapshot = await loadFolders(workspaceFolderRefs(), storeOptions());
      this.updateWatchers(snapshot.configDirs);
    } catch (error) {
      // For example an invalid configuration root; every folder then counts as unconfigured.
      failure = error instanceof Error ? error.message : String(error);
    }
    // Always set the keys, so that a failed reload hides the upload commands (fails closed).
    await vscode.commands.executeCommand('setContext', CONTEXT_HAS_CONFIG, snapshot.keys.hasConfig);
    await vscode.commands.executeCommand(
      'setContext',
      CONTEXT_HAS_UPLOAD_TARGET,
      snapshot.keys.hasUploadTarget,
    );
    this.onKeys(snapshot.keys);
    const failureMessage =
      failure === null ? null : `Deployment configuration could not be loaded: ${failure}`;
    if (this.notifications.shouldShow('', failureMessage) && failureMessage !== null) {
      void vscode.window.showErrorMessage(failureMessage);
    }
    for (const status of snapshot.statuses) {
      const message = describeProblem(status);
      if (this.notifications.shouldShow(status.folder.key, message) && message !== null) {
        void vscode.window
          .showWarningMessage(message, 'Open Config')
          .then((choice) =>
            choice === 'Open Config'
              ? vscode.commands.executeCommand(OPEN_CONFIG_COMMAND)
              : undefined,
          );
      }
    }
  }

  private updateWatchers(dirs: readonly string[]): void {
    const wanted = new Map<string, vscode.RelativePattern>();
    for (const dir of dirs) {
      const spec = watchSpec(dir, existsSync);
      if (spec !== null) {
        wanted.set(
          `${spec.base}\n${spec.pattern}`,
          new vscode.RelativePattern(vscode.Uri.file(spec.base), spec.pattern),
        );
      }
    }
    for (const [key, watcher] of this.watchers) {
      if (!wanted.has(key)) {
        watcher.dispose();
        this.watchers.delete(key);
      }
    }
    for (const [key, pattern] of wanted) {
      if (this.watchers.has(key)) {
        continue;
      }
      // The folder is outside the workspace; VS Code watches it there as well.
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      const onEvent = (): void => {
        this.schedule();
      };
      watcher.onDidCreate(onEvent);
      watcher.onDidChange(onEvent);
      watcher.onDidDelete(onEvent);
      this.watchers.set(key, watcher);
    }
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    for (const watcher of this.watchers.values()) {
      watcher.dispose();
    }
    this.watchers.clear();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  // Written to a file in VS Code's log folder as well; see SECURITY.md (what is logged).
  const channel = vscode.window.createOutputChannel('Deployment', { log: true });
  const log = new DeploymentLog(channel);
  const states = new ConnectionStates();
  const statusBar = new ConnectionStatusBar(states);
  const tracker = new ConfigTracker((keys) => {
    statusBar.setConfigured(keys.hasConfig);
  });
  // Closes every connection when the extension is deactivated.
  const connections = createConnectionManager(context.extensionPath);
  const stateEvents = connections.onDidChangeState((event) => {
    states.apply(event);
    statusBar.update();
    const what = event.status === 'disconnected' ? describeDisconnect(event.reason) : event.status;
    log.info(event.serverName, 'Connection', what);
  });
  const showLog = (): void => {
    channel.show(true);
  };
  const settingsPanels = new SettingsPanels({
    extensionUri: context.extensionUri,
    storeOptions,
    connections,
    log,
    showLog,
    onSaved: () => {
      void tracker.refresh();
    },
  });
  context.subscriptions.push(
    channel,
    statusBar,
    tracker,
    settingsPanels,
    {
      dispose: () => {
        stateEvents.dispose();
        connections.dispose();
      },
    },
    ...registerConnectionCommands({
      connections,
      states,
      log,
      showLog,
      loadServers: async () =>
        configuredSftpServers(await loadFolders(workspaceFolderRefs(), storeOptions())),
      openConfigCommand: OPEN_CONFIG_COMMAND,
    }),
    vscode.commands.registerCommand(OPEN_SETTINGS_COMMAND, () =>
      // The panel is returned to the extension tests only.
      openSettings(settingsPanels, context.extensionMode === vscode.ExtensionMode.Test),
    ),
    vscode.commands.registerCommand(OPEN_CONFIG_COMMAND, async () => {
      const uri = await openConfig(storeOptions);
      await tracker.refresh();
      return uri;
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      tracker.schedule();
    }),
    // Covers changes the watchers cannot see (for example when no configuration folder exists).
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        tracker.schedule();
      }
    }),
  );
  void tracker.refresh();
}

export function deactivate(): void {
  // Nothing to release; disposables are owned by the extension context.
}
