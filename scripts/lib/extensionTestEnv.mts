/**
 * The environment of the VS Code instances that run the extension tests.
 *
 * `@vscode/test-electron` starts VS Code with `{ ...process.env, ...env }`, so every variable of
 * the shell (or of the CI runner) would reach VS Code, the extension host and every log VS Code
 * writes; with `--log trace` VS Code prints its whole environment. Tokens and credentials of
 * the person or the runner would end up in test output and, in CI, in public logs.
 *
 * {@link extensionTestEnvironment} therefore maps every variable that is not on a short
 * allowlist to `undefined` (Node.js leaves such entries out of a child's environment) and points
 * the home and XDG directories at folders of the test instance. Together with
 * `--force-disable-user-env` (VS Code would otherwise read the environment of a login shell),
 * the instance sees only what is listed here.
 */

/**
 * Variables passed through unchanged when they are set. They hold no credentials: the command
 * search path, the locale, the temporary directory (VS Code's IPC sockets live there, and a
 * longer path would exceed the socket path limit), the display of the Linux CI runner (xvfb),
 * the Docker endpoint of the test SSH server and what Windows needs to start any process.
 */
export const INHERITED_VARIABLES: readonly string[] = [
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'DISPLAY',
  'XAUTHORITY',
  'XDG_RUNTIME_DIR',
  'DOCKER_HOST',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'PATHEXT',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'CommonProgramFiles',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
];

export interface InstanceDirectories {
  readonly home: string;
  readonly xdg: string;
}

export type ChildEnvironment = Record<string, string | undefined>;

/**
 * The `env` to pass to `@vscode/test-cli`: every variable of `parent` that is not inherited
 * becomes `undefined`, the home and XDG folders point into `dirs`, and `extra` is added.
 * On Windows variable names are compared without regard to case, as Windows does.
 */
export function extensionTestEnvironment(
  parent: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  dirs: InstanceDirectories,
  extra: Readonly<Record<string, string>>,
): ChildEnvironment {
  const normalize = (name: string): string => (platform === 'win32' ? name.toUpperCase() : name);
  const inherited = new Set(INHERITED_VARIABLES.map(normalize));
  const separator = platform === 'win32' ? '\\' : '/';
  const set: Record<string, string> = {
    HOME: dirs.home,
    XDG_CONFIG_HOME: `${dirs.xdg}${separator}config`,
    XDG_DATA_HOME: `${dirs.xdg}${separator}data`,
    XDG_CACHE_HOME: `${dirs.xdg}${separator}cache`,
    XDG_STATE_HOME: `${dirs.xdg}${separator}state`,
    ...(platform === 'win32'
      ? {
          USERPROFILE: dirs.home,
          APPDATA: `${dirs.xdg}${separator}AppData${separator}Roaming`,
          LOCALAPPDATA: `${dirs.xdg}${separator}AppData${separator}Local`,
        }
      : {
          // VS Code's pty host resolves the "shell environment" by running `$SHELL -i -l -c`
          // even with --force-disable-user-env, and logs the result at trace level. `true`
          // prints nothing, so no login shell (and no system profile script) runs and the
          // result is empty. (VS Code replaces /bin/false with /bin/bash.)
          SHELL: '/usr/bin/true',
        }),
    ...extra,
  };
  const replaced = new Set(Object.keys(set).map(normalize));
  const env: ChildEnvironment = {};
  for (const [name, value] of Object.entries(parent)) {
    const key = normalize(name);
    // The parent's own spelling, so that it overrides the inherited entry on Windows too.
    env[name] = inherited.has(key) && !replaced.has(key) ? value : undefined;
  }
  for (const [name, value] of Object.entries(set)) {
    for (const existing of Object.keys(env)) {
      if (normalize(existing) === normalize(name) && existing !== name) {
        env[existing] = undefined;
      }
    }
    env[name] = value;
  }
  return env;
}

/** The names of the variables a child started with `{ ...parent, ...env }` would receive. */
export function effectiveVariableNames(
  parent: Readonly<Record<string, string | undefined>>,
  env: ChildEnvironment,
): string[] {
  const merged = { ...parent, ...env };
  return Object.keys(merged).filter((name) => merged[name] !== undefined);
}
