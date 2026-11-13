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
