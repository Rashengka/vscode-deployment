# Contributing

Thanks for your interest in the project. Bug reports and pull requests are welcome; for larger
changes, please open an issue first so that we can agree on the approach.

Security problems are reported privately, see [SECURITY.md](SECURITY.md).

## Development setup

Requirements: Node.js 24 (see `.nvmrc`), npm, and Docker for the integration and extension tests.

```sh
npm ci
npm run check
```

The repository's `.npmrc` sets `ignore-scripts=true`, so dependency install scripts never run.
ssh2's optional native addon is therefore never built; the extension uses ssh2's pure JavaScript
implementation on every platform.

## Scripts

| Command                    | What it does                                                        |
| -------------------------- | ------------------------------------------------------------------- |
| `npm run check`            | Lint, type check and unit tests (the same command runs in CI).      |
| `npm run lint`             | ESLint and the Prettier check.                                      |
| `npm run typecheck`        | TypeScript in strict mode, without emitting files.                  |
| `npm test`                 | Unit tests (Vitest).                                                |
| `npm run test:integration` | Packages the extension and tests it against a local OpenSSH server. |
| `npm run test:extension`   | Packages the extension and runs tests inside VS Code against it.    |
| `npm run package`          | Production build and `.vsix`, with a check of the package contents. |
| `npm run check:leaks`      | Scans tracked files for absolute paths from a developer machine.    |

The integration and extension tests start a throwaway OpenSSH server in Docker
(`test/support/sshd`). It listens on `127.0.0.1` only, generates fresh keys on every start and
is removed after the tests. The image `vscode-deployment-test-sshd:local` is kept as a build
cache; remove it with `docker image rm vscode-deployment-test-sshd:local`. Tests never use your
own SSH configuration, keys or `known_hosts`.

On Linux without a display, run the extension tests with `xvfb-run -a npm run test:extension`.

## Leak check

`npm run check:leaks` (also run in CI) looks for absolute paths from a developer machine: home
directories on macOS, Linux and Windows, macOS temporary directories, and home paths encoded as
directory names. It scans the content and names of all files in the working tree and, in CI,
the messages and changed file names of every commit in the pushed range or pull request. It
reports file, line or commit and the pattern, never the matched text.

Limits: the patterns are generic, so names of people, companies or hosts are not detected; file
content is checked only as it is at the tip of the range, so text added and removed again
within the range is not seen; files containing NUL bytes (images, archives) are listed as
binary and their content is not scanned.

## Pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages
  (`feat:`, `fix:`, `docs:`, `test:`, `ci:`, `chore:`, `refactor:`).
- Add or update tests for every change in behaviour, and keep `npm run check` green.
- Do not commit secrets, keys (not even test keys), or real host names, user names or paths.
  Use `example.com`, `deploy@example.com`, `/var/www/app` and `/home/deploy` in examples.
- Add a line to the `Unreleased` section of `CHANGELOG.md` for user-visible changes.
