# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Project skeleton: build, lint, unit, integration and extension tests, and CI.
- Per-project configuration stored outside the repository
  (`${XDG_CONFIG_HOME:-~/.config}/vscode-deployment/projects/<encoded path>/`, on Windows
  `%APPDATA%\vscode-deployment\projects\<encoded path>\`), with a JSON schema, validation and
  atomic writes. On Linux and macOS the configuration is not loaded when its folders or files are
  symbolic links, belong to another user or are writable by other users; on Windows these
  permission checks do not apply.
- Command `Deployment: Open Deployment Config (JSON)`, which creates an empty configuration when
  there is none.
- OpenSSH client configuration resolver (`Host`, `Include`, identity files, known hosts files;
  proxies, `Match` and certificates are reported as unsupported; the macOS options `UseKeychain`
  and `NoHostAuthenticationForProxyCommand` are accepted and have no effect) and a `known_hosts`
  parser with hashed entries, `[host]:port`, wildcards, `@revoked` and SHA256 fingerprints.
- SSH connection core: one connection per server with queued operations, keepalive, idle
  disconnect and Disconnect All, closed when the configuration, the ssh configuration or
  `known_hosts` changes on disk. Host keys are checked strictly against `known_hosts` (unknown,
  changed and revoked keys are refused; nothing is ever written to it). Only key exchange,
  cipher, MAC and host key algorithms without SHA-1 and CBC are offered, and key files never
  sign with SHA-1 (`ssh-rsa`); signatures made by the user's SSH agent follow what the server
  allows. Key passphrases are asked for in a password box, only for the key the server accepts,
  at most three times, and never stored; the prompt closes when the connection attempt ends,
  and the time spent in it does not count against the connection timeouts. Encrypted OpenSSH
  keys are decrypted in a worker thread. Supported keys: OpenSSH, PEM RSA/EC and PuTTY version 2
  RSA; PKCS#8, PuTTY version 3, DSA and security keys are refused with a clear message. New
  required server setting `useSshAgent` (`false` unless the SSH agent should be used).
  Connections are refused in remote windows.
- Commands `Deployment: Test Connection` (user, home directory and login banner of a server),
  `Deployment: Disconnect` and `Deployment: Disconnect All`, a status bar item with the
  connection state and a menu, and the `Deployment` output channel. Text from the server is
  shown with control, bidirectional and invisible characters as visible escapes, never as a
  clickable link in a notification, and log entries stay on one line. Servers with the same id
  in different workspace folders get separate connections.
- Command `Deployment: Open Settings`: a settings panel (one per workspace folder) to add,
  edit, remove and choose the default server, with the connection settings of SFTP servers
  (SSH config host alias or manual connection, identity file picker, root path, keep-alive and
  idle disconnect, Test Connection) and the folder and web URL of in-place servers. The panel
  runs with a strict Content Security Policy, shows every value as plain text, and its messages
  are validated by the extension; it never receives a passphrase or key content. Saving uses the
  validation of `config.json` and refuses to overwrite a configuration that changed on disk
  since it was loaded. Closing the panel with unsaved changes asks whether to discard them, with
  Keep Editing as the default answer.
- Settings panel tabs Mappings and Excluded Paths: mappings with a folder picker inside the
  project and a remote folder picker, local and remote excluded paths, and Verify Mapping, which
  looks up 20 random project files of each mapping on the server (from `git ls-files`, otherwise
  the workspace files) and reports how many were found and which are missing. The root path
  gets `Browse…` and `Autodetect` (the home directory of the user on the server). The remote
  folder picker lists folders lazily, never above its base folder, shows symbolic links without
  opening them and lists at most 1000 entries per folder. An excluded path must name something
  below the project folder or the root path, not the folder itself.
- `SECURITY.md`: what the extension protects, what stays in memory and its limits, and what the
  secret leak test checks.
- Secret leak test: a passphrase typed into the real password box of VS Code (with trace logging)
  is searched for in the profile, the logs, the output channel, the home folder and heap
  snapshots. Extension tests run VS Code with an allowlisted environment and without access to
  the system keychain.
