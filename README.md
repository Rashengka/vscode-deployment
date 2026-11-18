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
- Path mappings and excluded paths.
- Upload the current file, all open files, or files selected in the Explorer, always after an
  explicit confirmation with _Cancel_ preselected.
- Compare a local file with its deployed version.
- Download a file from the server, with a confirmation before a local file is overwritten.

## License

MIT
