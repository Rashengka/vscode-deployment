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
  proxies, `Match` and certificates are reported as unsupported) and a `known_hosts` parser
  with hashed entries, `[host]:port`, wildcards, `@revoked` and SHA256 fingerprints.
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
