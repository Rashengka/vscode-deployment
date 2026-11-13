# vscode-deployment

A VS Code extension for deploying project files to a server, inspired by the Deployment
workflow of JetBrains IDEs.

> **Status: early development.** Nothing is released yet and the feature set below is the goal,
> not the current state.

## Planned features

- Per-project deployment configuration with one or more servers, stored outside the project
  repository.
- SFTP servers (with `~/.ssh/config` host aliases, strict host key verification and a passphrase
  that is only ever kept in memory) and in-place servers (a local folder with a web URL).
- Path mappings and excluded paths.
- Upload the current file, all open files, or files selected in the Explorer, always after an
  explicit confirmation with *Cancel* preselected.
- Compare a local file with its deployed version.
- Download a file from the server, with a confirmation before a local file is overwritten.

## License

MIT
