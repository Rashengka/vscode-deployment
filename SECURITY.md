# Security Policy

## Supported versions

The extension has not been released yet. Once it is, security fixes will be made for the latest
released version only.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub's
[private vulnerability reporting](https://github.com/Rashengka/vscode-deployment/security/advisories/new)
(the **Report a vulnerability** button on the repository's **Security** tab). Include the
extension version, your VS Code version and operating system, and the steps to reproduce.

Once the problem is confirmed, a fix and a security advisory will be published.

## What the extension protects

The extension connects to your servers with SSH keys, so it handles passphrases and decrypted
private keys. It is designed so that:

- **A passphrase is never stored.** It is asked for in a password input box when a key is
  needed, is not saved anywhere (no VS Code secret storage, settings, state, file or keychain)
  and is never written to a log, the `Deployment` output channel or an error message. After a
  disconnect (requested, idle time, server or network, configuration change) the next
  connection asks again; there is no automatic reconnect.
- **A connection lives only in the memory of the VS Code extension host.** SSH runs in the
  extension itself (no `ssh` process, no control socket); other processes cannot reuse the
  connection. When the window closes, the connection is gone.
- **Host keys are checked strictly** against your `known_hosts` files. Unknown, changed and
  revoked keys are refused; nothing is ever written to `known_hosts`.
- **Text from the server is untrusted.** Notifications show as little of it as possible, never
  as a clickable link (a server could otherwise offer a `command:` link). Login banners, file
  names and error messages are shown with control characters, bidirectional formatting characters and invisible characters
  replaced by visible escapes (for example `\x1b` or `\u202e`), and each log entry stays on one
  line.

- **The settings panel is not trusted.** `Deployment: Open Settings` is a webview with a strict
  Content Security Policy: no inline script or style, no remote resources, no `<base>` and no
  form submission; its single script runs only with a random nonce, and it may load files from
  the extension's `dist/webview` folder only. Every value (server names, hosts, paths, messages)
  is shown as plain text, never as HTML. The extension checks every message from the panel
  against a fixed schema with size limits and drops anything else. The panel never receives a
  passphrase or key content, only the path of an identity file; Test Connection asks for the
  passphrase in the extension, in the same password box as the command, and tests unsaved
  settings on a separate connection that is closed right afterwards. Autodetect, Verify Mapping
  and the remote folder picker work the same way (the picker's connection is closed when the
  picker is closed). The picker lists only folders below its base folder that it has listed
  itself; symbolic links are shown but never opened, and names that could not be part of a
  configured path (control, format or bidirectional characters, slashes) cannot be chosen.
  The picker tells a symbolic link from a folder by the attributes the server reports for each
  entry. A dishonest server can report a link as a folder, and a folder can be replaced by a
  link between listing and use, so this is no guarantee against a server that is not honest:
  it keeps an honest server's links from being followed by mistake.

- **Verify Mapping runs git.** Listing the project files can run code that a repository
  configures, so git is started by its absolute path (never from a folder inside the project),
  with `core.fsmonitor` switched off, without a shell, and only in a trusted workspace;
  otherwise the workspace files are used. Paths listed by git that could leave the project or
  the root path (`..`, absolute paths, backslashes, invisible characters) are dropped, and a
  path on the server is only looked up when it is below the root path. It only looks files up
  on the server (`stat`).

- **Compare with Deployed Version only reads.** The deployed version is read into memory, at
  most 20 MB (the limit holds while reading, not by the size the server reports; memory stays
  within about twice the data read, and a server that sends the file in many tiny pieces is
  stopped after a bounded number of read requests), and is shown in a read-only
  `vscode-deployment-remote:` document; writing, deleting or renaming it is refused. That file
  system never reads from a server itself: it serves only the versions the command downloaded,
  each at an address with its own random token, so an address made up by another extension or
  a link finds nothing. The token is valid for as long as the version is registered (while an
  editor tab shows it), not for a single read. Once open, the deployed version is a document
  like any other: other VS Code extensions can read it, as they can read every open document.
  Only the path the server's mappings give for a project file is read, never an excluded one. A
  symbolic link at that path is refused (checked with `lstat`), and a binary file is reported
  instead of shown. At most 10 versions (100 MB) are kept, and a version is dropped when its
  last editor tab closes.

## What is kept in memory, and for how long

JavaScript strings cannot be wiped, so some secret data exists in memory for a while as
strings that the garbage collector frees at some later point:

- **The passphrase.** VS Code returns the text of the password box to the extension as a
  string; it passes from the VS Code window to the extension host as a string message (VS Code's
  internal RPC). The extension turns it into a buffer right away and does not keep the string,
  but the string itself remains in memory until it is garbage-collected.
- **The key file.** The key file is read into a buffer. The ssh2 library converts key content to
  strings while parsing it. After decrypting an encrypted OpenSSH key, the extension passes the
  decrypted key to ssh2 as OpenSSH key text, which is built as a string.
- **The decrypted private key** is held by the extension host while it is needed to sign the
  login, and for keys that ssh2 keeps parsed, for the time of the connection. After a
  disconnect, the extension's code no longer refers to it, and its memory is freed by the
  garbage collector at some later point (see below for what the tests can show).

The extension does not control copies in the memory of other VS Code processes (for example
the window that showed the password box), and nothing protects memory against a debugger.

## What the tests check (secret leak canary)

A test runs the installed extension in VS Code with trace logging (`--log trace`), types a
random passphrase into the real password box, logs in to a test SSH server with a key
encrypted with that passphrase, and then searches for the passphrase (as UTF-8, UTF-16LE,
base64 and base64url at every alignment, hexadecimal, URL- and form-encoded) and for the
decrypted key in:

- the VS Code profile folder, including all of its logs (with trace logging VS Code writes
  about 25 log files),
- the extensions folder and the installed extension,
- the home and XDG folders of the test instance,
- the `Deployment` output channel as VS Code stores it on disk,
- heap snapshots of the extension host after the login (passphrase) and after Disconnect
  (passphrase and decrypted key).

Each search proves that it can find what it looks for: the passphrase is planted in control
files in each encoding, and a marker and a second key held by the test (parsed by ssh2, and as
OpenSSH key text) are found in the heap snapshots. Every location must contain at least one
file and one byte, and the logs at least one line. The test also checks that the environment
VS Code logs at trace level contains only the variables the tests allow. The trace output of
the test instance goes to a file only, never to the CI log, and the instance runs with `SHELL`
set to `/usr/bin/true`: VS Code 1.144 reads the environment of a login shell for its terminal
host even with `--force-disable-user-env`, and traces it.

Not searched: the standard output and error of the VS Code process, the temporary directory
(`TMPDIR`), and the compressed parts of the profile (LevelDB storage with snappy compression,
where a string would not appear as such).

Findings with VS Code 1.144:

- Neither trace logging nor any other log of VS Code contains the passphrase: VS Code does not
  log the result of the password box, also not at trace level. Not tested: the developer option
  `--logExtensionHostCommunication`, which logs the messages between the window and the
  extension host; do not use it while entering a passphrase.
- The `Deployment` output channel is written to a file in VS Code's log folder,
  `<user data>/logs/<session>/window1/exthost/rashengka.vscode-deployment/Deployment.log`, and
  is kept there like other VS Code logs. Each entry has the time, the server name and the
  action; it also contains the user name, `user@host:port`, the home directory, the server's
  login banner and the error messages of the server and of the connection. It never contains a
  passphrase or key content. Check it before attaching it to an issue.
- After Disconnect, the decrypted key is not found in the JavaScript strings of the extension
  host heap. Heap snapshots contain JavaScript strings only: buffers and key objects outside the
  JavaScript heap, and strings that V8 keeps as several parts (built by concatenation), are not
  covered by this search, so this is no proof that no copy is left in memory.

## Limits

The extension cannot protect against everything:

- **Other software running as you.** It protects against another process reusing an open
  connection, not against a process of the same user that can debug the extension host, install
  VS Code extensions, or change the deployment configuration, `~/.ssh/config` or `known_hosts`.
  When one of those files changes while a connection is open, the connection is closed and the
  next operation says that the configuration changed outside the extension. Other VS Code
  extensions run in the same extension host process and could read its memory.
- **SSH agent (`useSshAgent`).** It is off by default. When it is on, every process that can
  reach your SSH agent can open the same connection without a passphrase. Signatures made by your
  agent follow what the server allows: for an RSA key on a server that does not announce
  `server-sig-algs`, the agent may sign with SHA-1 (`ssh-rsa`). Key files used directly by the
  extension never sign with SHA-1.
- **Configuration folder.** On Linux and macOS a configuration is loaded only when every folder
  from the configuration root (`vscode-deployment`) down and every file is not a symbolic link,
  belongs to you and is not writable by the group or others. The parent of the root
  (`~/.config` or `$XDG_CONFIG_HOME`) is not checked: an account that can write there can remove
  or replace the folder, which makes the extension refuse a configuration it does not own, but
  cannot make it load one.
- **Windows.** POSIX owners and modes do not exist there. The configuration is protected by the
  permissions of your user profile folder (`%APPDATA%`), which the extension does not inspect.
- **Upload history (`state.json`).** Several windows update it by merging, not by overwriting.
  A write by another process at the same moment can still be lost, and anybody who can rewrite
  the file can hide a conflict warning (a file changed on the server by somebody else). The
  history never decides where files go.
- **Saving from the settings panel.** A save is refused when the configuration changed on disk
  since the panel loaded it. The check happens right before the file is atomically replaced, so
  a change by another process in the short time between the check and the replacement is not
  detected and is overwritten. Open connections treat the file as the extension's own from the
  start of the save until right after the replacement, when the extension records the new file:
  a change by another process in that window is not reported, and the connections are compared
  with the servers the extension saved, not with what the file then holds.
- **Compare with Deployed Version and symbolic links.** SFTP cannot open a file without
  following a link, so the `lstat` check and the read are two requests: a server (or another
  user on it) that replaces the file with a link in between can make the extension read the
  link's target. The folders above the file are not checked for links at all. Either way the
  content is only shown, never written anywhere, and the 20 MB limit still holds.
- **`VSCODE_DEPLOYMENT_CONFIG_DIR`.** This environment variable moves the configuration root
  (it exists for tests). Whoever controls the environment VS Code starts with can point the
  extension to a different configuration; the same ownership checks apply to it.
