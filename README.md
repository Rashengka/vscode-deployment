# vscode-deployment

A VS Code extension for deploying project files to a server, inspired by the Deployment
workflow of JetBrains IDEs.

> **Status: early development.** Nothing is released yet and the feature set below is the goal,
> not the current state.

## Available so far

- **Deployment: Open Deployment Config (JSON)** creates or opens the configuration of the
  workspace folder. It is stored outside the repository, in
  `${XDG_CONFIG_HOME:-~/.config}/vscode-deployment/projects/` (on Windows in
  `%APPDATA%\vscode-deployment\projects\`).
- **Deployment: Open Settings** opens a settings panel for the servers of a workspace folder:
  add SFTP or in-place servers, remove them, choose the default server, pick an SSH config host
  alias or enter host, port, user and identity file manually, set the root path, keep-alive and
  idle disconnect, and run Test Connection with the unsaved settings. The root path can be typed,
  chosen with `Browse…` in a remote folder picker, or set with `Autodetect` (the home directory
  of the user on the server). The **Mappings** tab maps project folders (chosen with a folder
  picker inside the project) to folders on the server (chosen with the remote folder picker),
  and **Verify Mapping** looks up 20 random project files of each mapping on the server and
  reports which are missing. The **Excluded Paths** tab lists local and remote paths that are
  never deployed. Saving validates the settings and never overwrites a configuration that was
  changed elsewhere in the meantime; closing the panel with unsaved changes asks before they are
  discarded, with Keep Editing preselected.
- **Deployment: Test Connection** connects to an SFTP server of the configuration and shows the
  user, the home directory and the server's login banner. Host aliases from `~/.ssh/config` are
  used, host keys are checked against `known_hosts`, and a key passphrase is asked for in a
  password box and never stored.
- **Deployment: Disconnect** and **Disconnect All** close connections. The status bar shows the
  connection (`$(plug)` and the server name); clicking it opens a menu with these commands.
- The **Deployment** output channel logs connections and their results with the time and the
  server, never a passphrase or key content.

See [SECURITY.md](SECURITY.md) for what the extension protects and its limits.

## Planned features

- Per-project deployment configuration with one or more servers, stored outside the project
  repository.
- SFTP servers (with `~/.ssh/config` host aliases, strict host key verification and a passphrase
  that is only ever kept in memory) and in-place servers (a local folder with a web URL).
- Upload the current file, all open files, or files selected in the Explorer, always after an
  explicit confirmation with _Cancel_ preselected.
- Compare a local file with its deployed version.
- Download a file from the server, with a confirmation before a local file is overwritten.

## License

MIT
