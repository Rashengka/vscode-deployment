/**
 * A minimal, side-effect free resolver for OpenSSH client configuration (`ssh_config`).
 *
 * It resolves the options this extension uses for one host alias, following OpenSSH rules:
 * `Host` blocks with wildcards and negation, the first obtained value wins, `Include` with
 * globs, the user file before the system file. It never runs a command. Anything that would
 * make OpenSSH connect differently than this extension can is an error that names the
 * directive, so a connection is never made in a way the user did not configure:
 *
 * - `Match` anywhere (in any block and any included file) is an error. Match blocks are never
 *   evaluated, because some criteria run commands and others trigger a second parsing pass.
 * - Proxies, local commands, PKCS#11, certificates, revoked key files, host name
 *   canonicalization and `RefuseConnection` are errors whenever they apply to the host with a
 *   value other than "not set".
 * - Unknown directives are errors, as in OpenSSH ("Bad configuration option"), unless an
 *   earlier applicable `IgnoreUnknown` lists them.
 *
 * Case handling follows OpenSSH: keywords are case-insensitive; `Host` patterns are matched
 * case-sensitively against the alias exactly as given (OpenSSH matches the unmodified command
 * line argument); the host name is lower-cased unless it is an IP address, and `HostKeyAlias`
 * is lower-cased, because that is how OpenSSH looks them up in known_hosts.
 *
 * All file access goes through {@link SshConfigEnvironment}, so callers decide what is read.
 */
import { isIP, isIPv6 } from 'node:net';
import { posix, win32 } from 'node:path';
import { isWildcardOrNegatedPattern, matchPatternList, matchWildcard } from './patterns';

export interface SshConfigEnvironment {
  /** Home directory of the local user; `~` and `%d` expand to it. */
  readonly homeDirectory: string;
  /** Name of the local user; `%u` expands to it and it is the default remote user. */
  readonly localUser: string;
  /** Path flavour of the local machine. Defaults to the current platform. */
  readonly platform?: 'posix' | 'win32';
  /** `%PROGRAMDATA%` on Windows, for the system files. Defaults to `C:\ProgramData`. */
  readonly programDataDirectory?: string;
  /** User configuration file. Defaults to `<home>/.ssh/config`. */
  readonly userConfigPath?: string;
  /**
   * System-wide configuration file, read after the user file. Defaults to the platform's
   * (`/etc/ssh/ssh_config`, or `%PROGRAMDATA%\ssh\ssh_config` on Windows); `null` disables it.
   */
  readonly systemConfigPath?: string | null;
  /**
   * Returns the text of a regular file, or `undefined` only when the file does not exist.
   * Every other failure (permissions, not a regular file, too large) must throw.
   */
  readFile(path: string): Promise<string | undefined>;
  /** Returns the names in a directory, or `undefined` when it does not exist. */
  listDirectory(path: string): Promise<readonly string[] | undefined>;
}

export interface ResolvedSshHost {
  /** The alias as given, e.g. `production`. */
  readonly alias: string;
  /** `HostName` (or the alias), lower-cased unless it is an IP address. */
  readonly hostName: string;
  readonly port: number;
  readonly user: string;
  /** Identity files to try in this order, already expanded to absolute paths. */
  readonly identityFiles: readonly string[];
  /** True when no `IdentityFile` applies and `identityFiles` are the OpenSSH defaults. */
  readonly identityFilesAreDefaults: boolean;
  readonly identitiesOnly: boolean;
  /**
   * `IdentityAgent` as configured: `none`, `SSH_AUTH_SOCK`, an absolute socket path, or
   * `undefined` when not set.
   */
  readonly identityAgent: string | undefined;
  readonly userKnownHostsFiles: readonly string[];
  readonly globalKnownHostsFiles: readonly string[];
  /** Lower-cased `HostKeyAlias`, as OpenSSH uses it. */
  readonly hostKeyAlias: string | undefined;
  /**
   * The name to look up in known_hosts: `HostKeyAlias` when set (OpenSSH then uses it as is,
   * without the port), otherwise the host name, as `[host]:port` when the port is not 22.
   */
  readonly knownHostsName: string;
}

/** An ssh configuration this extension cannot follow. `directive` names the offending option. */
export class SshConfigError extends Error {
  readonly directive: string | undefined;
  readonly file: string | undefined;
  readonly line: number | undefined;

  constructor(
    message: string,
    directive: string | undefined,
    file: string | undefined,
    line: number | undefined,
  ) {
    super(file === undefined ? message : `${message} (${file}:${line ?? 0})`);
    this.name = 'SshConfigError';
    this.directive = directive;
    this.file = file;
    this.line = line;
  }
}

/** Include nesting limit, the same as OpenSSH. */
const MAX_INCLUDE_DEPTH = 16;
/** Upper bounds for what one resolution reads, so a glob cannot fan out without limit. */
export const MAX_CONFIG_FILES = 256;
export const MAX_CONFIG_FILE_BYTES = 1024 * 1024;

const DEFAULT_IDENTITY_FILES = ['id_ed25519', 'id_ecdsa', 'id_rsa'];
const DEFAULT_USER_KNOWN_HOSTS_FILES = ['~/.ssh/known_hosts', '~/.ssh/known_hosts2'];

/**
 * Directives that would make OpenSSH behave in a way this extension cannot reproduce. Each is
 * an error whenever it applies to the host with a value other than the one listed as "not
 * set". Earlier "not set" values do not hide later ones (stricter than OpenSSH, on purpose).
 */
const UNSUPPORTED_DIRECTIVES: ReadonlyMap<string, { name: string; unset: readonly string[] }> =
  new Map([
    ['proxyjump', { name: 'ProxyJump', unset: ['none'] }],
    ['proxycommand', { name: 'ProxyCommand', unset: ['none'] }],
    ['knownhostscommand', { name: 'KnownHostsCommand', unset: ['none'] }],
    ['localcommand', { name: 'LocalCommand', unset: ['none'] }],
    ['pkcs11provider', { name: 'PKCS11Provider', unset: ['none'] }],
    ['smartcarddevice', { name: 'SmartcardDevice', unset: ['none'] }],
    ['certificatefile', { name: 'CertificateFile', unset: ['none'] }],
    ['revokedhostkeys', { name: 'RevokedHostKeys', unset: ['none'] }],
    ['canonicalizehostname', { name: 'CanonicalizeHostname', unset: ['no', 'false'] }],
    ['refuseconnection', { name: 'RefuseConnection', unset: ['no', 'false'] }],
  ]);

/** Directives this resolver reads. `identityfile2` is OpenSSH's obsolete alias. */
const USED_DIRECTIVES = new Set([
  'host',
  'match',
  'include',
  'ignoreunknown',
  'hostname',
  'user',
  'port',
  'identityfile',
  'identityfile2',
  'identitiesonly',
  'identityagent',
  'userknownhostsfile',
  'globalknownhostsfile',
  'hostkeyalias',
]);

/**
 * Other OpenSSH client keywords (from OpenSSH's readconf.c). They do not change which host is
 * reached or how its identity is checked, or the extension decides them itself (algorithms,
 * authentication order, host key checking is always strict), so they are ignored.
 *
 * `BindAddress`, `BindInterface` and `AddressFamily` only choose the local address or the IP
 * family of the outgoing connection. Ignoring them can make a connection fail or leave from
 * another interface, but the server is still verified against known_hosts, so it cannot
 * make the extension trust a different host.
 */
const IGNORED_DIRECTIVES = new Set([
  'protocol',
  'cipher',
  'fallbacktorsh',
  'globalknownhostsfile2',
  'rhostsauthentication',
  'userknownhostsfile2',
  'useroaming',
  'usersh',
  'useprivilegedport',
  'afstokenpassing',
  'kerberosauthentication',
  'kerberostgtpassing',
  'rsaauthentication',
  'rhostsrsaauthentication',
  'compressionlevel',
  'gssapiauthentication',
  'gssapidelegatecredentials',
  'forwardagent',
  'forwardx11',
  'forwardx11trusted',
  'forwardx11timeout',
  'exitonforwardfailure',
  'xauthlocation',
  'gatewayports',
  'passwordauthentication',
  'kbdinteractiveauthentication',
  'kbdinteractivedevices',
  'challengeresponseauthentication',
  'skeyauthentication',
  'tisauthentication',
  'pubkeyauthentication',
  'dsaauthentication',
  'hostbasedauthentication',
  'addkeystoagent',
  'ciphers',
  'macs',
  'remoteforward',
  'localforward',
  'permitremoteopen',
  'tag',
  'escapechar',
  'connectionattempts',
  'batchmode',
  'checkhostip',
  'stricthostkeychecking',
  'compression',
  'tcpkeepalive',
  'keepalive',
  'numberofpasswordprompts',
  'syslogfacility',
  'loglevel',
  'logverbose',
  'dynamicforward',
  'preferredauthentications',
  'hostkeyalgorithms',
  'casignaturealgorithms',
  'bindaddress',
  'bindinterface',
  'clearallforwardings',
  'enablesshkeysign',
  'verifyhostkeydns',
  'nohostauthenticationforlocalhost',
  'rekeylimit',
  'connecttimeout',
  'addressfamily',
  'serveraliveinterval',
  'serveralivecountmax',
  'sendenv',
  'setenv',
  'controlpath',
  'controlmaster',
  'controlpersist',
  'hashknownhosts',
  'tunnel',
  'tunneldevice',
  'permitlocalcommand',
  'remotecommand',
  'visualhostkey',
  'kexalgorithms',
  'ipqos',
  'requesttty',
  'sessiontype',
  'stdinnull',
  'forkafterauthentication',
  'proxyusefdpass',
  'canonicaldomains',
  'canonicalizefallbacklocal',
  'canonicalizemaxdots',
  'canonicalizepermittedcnames',
  'streamlocalbindmask',
  'streamlocalbindunlink',
  'fingerprinthash',
  'updatehostkeys',
  'hostbasedacceptedalgorithms',
  'hostbasedkeytypes',
  'pubkeyacceptedalgorithms',
  'pubkeyacceptedkeytypes',
  'securitykeyprovider',
  'requiredrsasize',
  'enableescapecommandline',
  'obscurekeystroketiming',
  'channeltimeout',
  'versionaddendum',
  'warnweakcrypto',
]);

interface ConfigLine {
  /** Lower-cased keyword. */
  readonly keyword: string;
  readonly args: readonly string[];
  readonly file: string;
  readonly line: number;
}

function fail(message: string, directive: string | undefined, line?: ConfigLine): never {
  throw new SshConfigError(message, directive, line?.file, line?.line);
}

/**
 * Takes the keyword like OpenSSH's `strdelim`: it ends at whitespace or one `=`, and a double
 * quote inside it is removed together with its closing quote (`Proxy"Jump"` is `ProxyJump`).
 */
function splitKeyword(text: string, file: string, line: number): { keyword: string; rest: string } {
  const index = text.search(/[ \t\r\n"=]/);
  if (index === -1) {
    return { keyword: text, rest: '' };
  }
  const head = text.slice(0, index);
  const delimiter = text.charAt(index);
  if (delimiter === '"') {
    const close = text.indexOf('"', index + 1);
    if (close === -1) {
      throw new SshConfigError('Unterminated quote in keyword', undefined, file, line);
    }
    return {
      keyword: head + text.slice(index + 1, close),
      rest: text.slice(close + 1).replace(/^[ \t\r\n]+/, ''),
    };
  }
  let rest = text.slice(index + 1).replace(/^[ \t\r\n]+/, '');
  if (delimiter !== '=' && rest.startsWith('=')) {
    rest = rest.slice(1).replace(/^[ \t\r\n]+/, '');
  }
  return { keyword: head, rest };
}

/** Splits arguments exactly like OpenSSH's `argv_split` with comments enabled. */
function splitArguments(text: string, file: string, line: number): string[] {
  const args: string[] = [];
  let i = 0;
  while (i < text.length) {
    const start = text.charAt(i);
    if (start === ' ' || start === '\t') {
      i += 1;
      continue;
    }
    if (start === '#') {
      break;
    }
    let quote = '';
    let arg = '';
    for (; i < text.length; i += 1) {
      const ch = text.charAt(i);
      const next = text.charAt(i + 1);
      if (ch === '\\') {
        if (next === "'" || next === '"' || next === '\\' || (quote === '' && next === ' ')) {
          i += 1;
          arg += next;
        } else {
          arg += ch;
        }
      } else if (quote === '' && (ch === ' ' || ch === '\t')) {
        break;
      } else if (quote === '' && (ch === '"' || ch === "'")) {
        quote = ch;
      } else if (quote !== '' && ch === quote) {
        quote = '';
      } else {
        arg += ch;
      }
    }
    if (quote !== '') {
      throw new SshConfigError('Unterminated quote', undefined, file, line);
    }
    args.push(arg);
  }
  return args;
}

function parseLines(text: string, file: string): ConfigLine[] {
  const result: ConfigLine[] = [];
  text
    .replace(/^\uFEFF/, '')
    .split('\n')
    .forEach((raw, index) => {
      const lineNumber = index + 1;
      const trimmed = raw.replace(/[ \t\r\n\f]+$/, '').replace(/^[ \t\r\n]+/, '');
      if (trimmed === '' || trimmed.startsWith('#')) {
        return;
      }
      const { keyword, rest } = splitKeyword(trimmed, file, lineNumber);
      if (keyword === '' || keyword.startsWith('#')) {
        return;
      }
      const args = splitArguments(rest, file, lineNumber);
      if (args.length === 0) {
        throw new SshConfigError(
          `No argument after keyword "${keyword}"`,
          keyword,
          file,
          lineNumber,
        );
      }
      result.push({ keyword: keyword.toLowerCase(), args, file, line: lineNumber });
    });
  return result;
}

class PathTools {
  readonly path: typeof posix;
  readonly isWindows: boolean;
  private readonly env: SshConfigEnvironment;

  constructor(env: SshConfigEnvironment) {
    this.env = env;
    this.isWindows =
      (env.platform ?? (process.platform === 'win32' ? 'win32' : 'posix')) === 'win32';
    this.path = this.isWindows ? win32 : posix;
  }

  get sshDirectory(): string {
    return this.path.join(this.env.homeDirectory, '.ssh');
  }

  /** OpenSSH's system directory: `/etc/ssh`, or `%PROGRAMDATA%\ssh` on Windows. */
  get systemDirectory(): string {
    return this.isWindows
      ? win32.join(this.env.programDataDirectory ?? 'C:\\ProgramData', 'ssh')
      : '/etc/ssh';
  }

  /** Expands a leading `~`. `~user` is not supported. */
  expandTilde(value: string, directive: string, line?: ConfigLine): string {
    if (value === '~') {
      return this.env.homeDirectory;
    }
    if (value.startsWith('~/') || (this.isWindows && value.startsWith('~\\'))) {
      return this.path.join(this.env.homeDirectory, value.slice(2));
    }
    if (value.startsWith('~')) {
      fail(`${directive}: "~user" paths are not supported`, directive, line);
    }
    return value;
  }

  /** An absolute path, or an error: relative paths would depend on the working directory. */
  requireAbsolute(value: string, directive: string, line?: ConfigLine): string {
    const expanded = this.expandTilde(value, directive, line);
    if (!this.path.isAbsolute(expanded)) {
      fail(
        `${directive}: relative path "${value}" is not supported; use an absolute path or ~/`,
        directive,
        line,
      );
    }
    return this.path.normalize(expanded);
  }

  isNullDevice(path: string): boolean {
    if (this.isWindows) {
      const base = win32.basename(path).toLowerCase();
      return base === 'nul' || base.startsWith('nul.');
    }
    return posix.normalize(path) === '/dev/null';
  }
}

/**
 * Expands `%` tokens; any token not in `tokens` is an error naming the directive. When
 * `forPath` is set, a token value must not contain a path separator or be `.`/`..`, so that a
 * host name or user name can never point a path somewhere else. `%d` (the home directory) is
 * exempt because it is a path by definition.
 */
function expandTokens(
  text: string,
  tokens: Readonly<Record<string, string>>,
  directive: string,
  line: ConfigLine | undefined,
  forPath: boolean,
): string {
  if (text.includes('${')) {
    fail(`${directive}: environment variables (\${...}) are not supported`, directive, line);
  }
  let result = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch !== '%') {
      result += ch;
      continue;
    }
    const letter = text.charAt(i + 1);
    i += 1;
    if (letter === '%') {
      result += '%';
      continue;
    }
    const replacement = Object.hasOwn(tokens, letter) ? tokens[letter] : undefined;
    if (letter === '' || replacement === undefined) {
      fail(`${directive}: token %${letter} is not supported`, directive, line);
    }
    if (
      forPath &&
      letter !== 'd' &&
      (/[/\\]/.test(replacement) || replacement === '.' || replacement === '..')
    ) {
      fail(
        `${directive}: the value of %${letter} cannot be used in a path ("${replacement}")`,
        directive,
        line,
      );
    }
    result += replacement;
  }
  return result;
}

function hasGlob(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('?');
}

interface WalkState {
  filesRead: number;
  ignoreUnknown: string | undefined;
}

interface WalkContext {
  readonly env: SshConfigEnvironment;
  readonly tools: PathTools;
  readonly state: WalkState;
  readonly includeSystemConfig: boolean;
  /** Called for every line that is not `Host`, `Match` or `Include`, with its state. */
  readonly onOption: (line: ConfigLine, active: boolean) => void;
  /** Called for every `Host` line, active or not. */
  readonly onHost?: (line: ConfigLine) => void;
  /** Decides whether a `Host` line applies. */
  readonly hostApplies: (line: ConfigLine) => boolean;
  /** Called for every `Match` line; returns whether the block counts as active. */
  readonly onMatch: (line: ConfigLine) => boolean;
}

async function readConfigFile(
  ctx: WalkContext,
  path: string,
  line: ConfigLine | undefined,
): Promise<string | undefined> {
  ctx.state.filesRead += 1;
  if (ctx.state.filesRead > MAX_CONFIG_FILES) {
    fail(`Include: more than ${MAX_CONFIG_FILES} configuration files`, 'Include', line);
  }
  const text = await ctx.env.readFile(path);
  if (text !== undefined && Buffer.byteLength(text, 'utf8') > MAX_CONFIG_FILE_BYTES) {
    throw new SshConfigError(
      `Configuration file is larger than ${MAX_CONFIG_FILE_BYTES} bytes`,
      undefined,
      path,
      undefined,
    );
  }
  return text;
}

/** Expands `*` and `?` in every path component; like glob(3), wildcards skip dot files. */
async function expandGlob(ctx: WalkContext, pattern: string, line: ConfigLine): Promise<string[]> {
  const { tools } = ctx;
  if (pattern.includes('[')) {
    fail('Include: character classes ([...]) are not supported', 'Include', line);
  }
  if (!hasGlob(pattern)) {
    return [pattern];
  }
  const { root } = tools.path.parse(pattern);
  const parts = pattern
    .slice(root.length)
    .split(/[\\/]/)
    .filter((part) => part !== '');
  let candidates = [root];
  for (const part of parts) {
    const next: string[] = [];
    for (const base of candidates) {
      if (!hasGlob(part)) {
        next.push(tools.path.join(base, part));
        continue;
      }
      const names = (await ctx.env.listDirectory(base)) ?? [];
      const matches = names
        .filter((name) => !name.startsWith('.') || part.startsWith('.'))
        .filter((name) => matchWildcard(name, part, true))
        .sort();
      next.push(...matches.map((name) => tools.path.join(base, name)));
    }
    candidates = next;
    if (candidates.length > MAX_CONFIG_FILES) {
      fail(`Include: the pattern matches more than ${MAX_CONFIG_FILES} files`, 'Include', line);
    }
  }
  return candidates;
}

/**
 * Reads one configuration file the way OpenSSH does. Lines before the first `Host`/`Match`
 * apply when the file was entered in an active state; an `Include` in an inactive block is
 * still read (OpenSSH reads it too), with everything in it inactive.
 */
async function walkFile(
  ctx: WalkContext,
  path: string,
  includeBase: string,
  startActive: boolean,
  neverMatch: boolean,
  depth: number,
  includedFrom: ConfigLine | undefined,
): Promise<void> {
  const text = await readConfigFile(ctx, path, includedFrom);
  if (text === undefined) {
    return;
  }
  let active = startActive && !neverMatch;
  for (const line of parseLines(text, path)) {
    if (line.keyword === 'host') {
      if (line.args.some((arg) => arg === '')) {
        fail('Host: empty pattern', 'Host', line);
      }
      ctx.onHost?.(line);
      active = !neverMatch && ctx.hostApplies(line);
    } else if (line.keyword === 'match') {
      // Called even in inactive includes, so that a Match line anywhere is noticed.
      const applies = ctx.onMatch(line);
      active = !neverMatch && applies;
    } else if (line.keyword === 'include') {
      if (depth >= MAX_INCLUDE_DEPTH) {
        fail(`Include: nested too deeply (more than ${MAX_INCLUDE_DEPTH} levels)`, 'Include', line);
      }
      for (const arg of line.args) {
        if (arg === '') {
          fail('Include: empty file name', 'Include', line);
        }
        if (arg.includes('%') || arg.includes('$')) {
          fail('Include: tokens and environment variables are not supported', 'Include', line);
        }
        const expanded = ctx.tools.expandTilde(arg, 'Include', line);
        // Relative includes are relative to ~/.ssh in user files and to the system directory
        // in system files, wherever the including line is (not to the including file).
        const absolute = ctx.tools.path.isAbsolute(expanded)
          ? expanded
          : ctx.tools.path.join(includeBase, expanded);
        for (const file of await expandGlob(ctx, absolute, line)) {
          await walkFile(ctx, file, includeBase, active, neverMatch || !active, depth + 1, line);
        }
      }
    } else {
      ctx.onOption(line, active);
    }
  }
}

async function walkConfig(ctx: WalkContext): Promise<void> {
  const { env, tools } = ctx;
  const userConfig = env.userConfigPath ?? tools.path.join(tools.sshDirectory, 'config');
  await walkFile(ctx, userConfig, tools.sshDirectory, true, false, 0, undefined);
  if (!ctx.includeSystemConfig || env.systemConfigPath === null) {
    return;
  }
  const systemConfig = env.systemConfigPath ?? tools.path.join(tools.systemDirectory, 'ssh_config');
  await walkFile(ctx, systemConfig, tools.systemDirectory, true, false, 0, undefined);
}

function singleArgument(line: ConfigLine, name: string): string {
  const [first, extra] = line.args;
  if (first === undefined || first === '') {
    fail(`${name}: missing value`, name, line);
  }
  if (extra !== undefined) {
    fail(`${name}: expected a single value`, name, line);
  }
  return first;
}

function parsePort(line: ConfigLine): number {
  const text = singleArgument(line, 'Port');
  const port = /^\d{1,5}$/.test(text) ? Number(text) : NaN;
  if (!(port >= 1 && port <= 65535)) {
    fail(`Port: "${text}" is not a valid port`, 'Port', line);
  }
  return port;
}

function parseYesNo(line: ConfigLine, name: string): boolean {
  const text = singleArgument(line, name).toLowerCase();
  if (text === 'yes' || text === 'true') {
    return true;
  }
  if (text === 'no' || text === 'false') {
    return false;
  }
  return fail(`${name}: expected yes or no, got "${text}"`, name, line);
}

/**
 * A host alias or host name this extension accepts: letters, digits, `.`, `_`, `-`, and `:`
 * only as part of an IPv6 address. Never `.` or `..`, never a leading `-`. This keeps the
 * value safe to substitute into file names.
 */
export function isValidHostToken(value: string): boolean {
  if (!/^[A-Za-z0-9._:-]+$/.test(value) || value === '.' || value === '..') {
    return false;
  }
  if (value.startsWith('-')) {
    return false;
  }
  return !value.includes(':') || isIPv6(value);
}

function expandHostName(line: ConfigLine, alias: string): string {
  const host = expandTokens(
    singleArgument(line, 'HostName'),
    { h: alias },
    'HostName',
    line,
    false,
  );
  if (!isValidHostToken(host)) {
    fail(`HostName: "${host}" is not a valid host name`, 'HostName', line);
  }
  return host;
}

function expandUser(line: ConfigLine, env: SshConfigEnvironment): string {
  return expandTokens(singleArgument(line, 'User'), { u: env.localUser }, 'User', line, false);
}

function knownHostsFiles(
  line: ConfigLine | undefined,
  defaults: readonly string[],
  directive: 'UserKnownHostsFile' | 'GlobalKnownHostsFile',
  tokens: Readonly<Record<string, string>>,
  tools: PathTools,
): string[] {
  const files = line === undefined ? defaults : line.args;
  const hasNone = files.some((file) => file.toLowerCase() === 'none');
  if (directive === 'UserKnownHostsFile') {
    const paths = hasNone
      ? []
      : files.map((file) =>
          tools.requireAbsolute(expandTokens(file, tokens, directive, line, true), directive, line),
        );
    if (hasNone || paths.some((path) => tools.isNullDevice(path))) {
      fail(
        'UserKnownHostsFile none or a null device would disable host key checking, which is not supported',
        directive,
        line,
      );
    }
    return paths;
  }
  if (hasNone) {
    if (files.length > 1) {
      fail('GlobalKnownHostsFile: "none" must appear alone', directive, line);
    }
    // No global file is a normal setup; the user file still has to know the host.
    return [];
  }
  return files
    .map((file) =>
      tools.requireAbsolute(expandTokens(file, tokens, directive, line, true), directive, line),
    )
    .filter((path) => !tools.isNullDevice(path));
}

interface RawOptions {
  hostName?: ConfigLine;
  user?: ConfigLine;
  port?: ConfigLine;
  identityFiles: ConfigLine[];
  identitiesOnly?: ConfigLine;
  identityAgent?: ConfigLine;
  userKnownHostsFile?: ConfigLine;
  globalKnownHostsFile?: ConfigLine;
  hostKeyAlias?: ConfigLine;
}

/**
 * Resolves the options for `alias` from the user and system ssh configuration.
 *
 * Throws {@link SshConfigError} for anything that would make OpenSSH behave differently than
 * this extension can: see the module documentation. `StrictHostKeyChecking` is ignored on
 * purpose; host keys are always checked strictly.
 */
export async function resolveSshHost(
  alias: string,
  env: SshConfigEnvironment,
): Promise<ResolvedSshHost> {
  if (!isValidHostToken(alias)) {
    fail(`"${alias}" is not a valid host alias`, undefined);
  }
  const tools = new PathTools(env);
  const state: WalkState = { filesRead: 0, ignoreUnknown: undefined };
  const raw: RawOptions = { identityFiles: [] };

  const onOption = (line: ConfigLine, active: boolean): void => {
    const unsupported = UNSUPPORTED_DIRECTIVES.get(line.keyword);
    if (unsupported !== undefined) {
      const [first, extra] = line.args;
      const isUnset =
        extra === undefined && unsupported.unset.includes((first ?? '').toLowerCase());
      if (active && !isUnset) {
        fail(`${unsupported.name} is not supported`, unsupported.name, line);
      }
      return;
    }
    if (!USED_DIRECTIVES.has(line.keyword) && !IGNORED_DIRECTIVES.has(line.keyword)) {
      // Like OpenSSH, an unknown keyword is an error in any block, unless an earlier
      // applicable IgnoreUnknown names it.
      const ignored =
        state.ignoreUnknown !== undefined &&
        matchPatternList(line.keyword, state.ignoreUnknown.split(',')) === 'matched';
      if (!ignored) {
        fail(`Bad configuration option "${line.keyword}"`, line.keyword, line);
      }
      return;
    }
    if (!active) {
      return;
    }
    switch (line.keyword) {
      case 'ignoreunknown':
        state.ignoreUnknown ??= singleArgument(line, 'IgnoreUnknown');
        break;
      case 'hostname':
        raw.hostName ??= line;
        break;
      case 'user':
        raw.user ??= line;
        break;
      case 'port':
        raw.port ??= line;
        break;
      case 'identityfile':
      case 'identityfile2':
        raw.identityFiles.push(line);
        break;
      case 'identitiesonly':
        raw.identitiesOnly ??= line;
        break;
      case 'identityagent':
        raw.identityAgent ??= line;
        break;
      case 'userknownhostsfile':
        raw.userKnownHostsFile ??= line;
        break;
      case 'globalknownhostsfile':
        raw.globalKnownHostsFile ??= line;
        break;
      case 'hostkeyalias':
        raw.hostKeyAlias ??= line;
        break;
      default:
        break;
    }
  };

  await walkConfig({
    env,
    tools,
    state,
    includeSystemConfig: true,
    onOption,
    hostApplies: (line) => matchPatternList(alias, line.args, true) === 'matched',
    onMatch: (line) =>
      fail(
        'Match blocks are not supported (they are never evaluated, whatever their criteria)',
        'Match',
        line,
      ),
  });

  const rawHostName = raw.hostName === undefined ? alias : expandHostName(raw.hostName, alias);
  const hostName = isIP(rawHostName) === 0 ? rawHostName.toLowerCase() : rawHostName;
  const user = raw.user === undefined ? env.localUser : expandUser(raw.user, env);
  const port = raw.port === undefined ? 22 : parsePort(raw.port);
  const identitiesOnly =
    raw.identitiesOnly === undefined ? false : parseYesNo(raw.identitiesOnly, 'IdentitiesOnly');
  const hostKeyAlias =
    raw.hostKeyAlias === undefined
      ? undefined
      : singleArgument(raw.hostKeyAlias, 'HostKeyAlias').toLowerCase();

  const pathTokens: Record<string, string> = {
    d: env.homeDirectory,
    u: env.localUser,
    h: hostName,
    n: alias,
    p: String(port),
    r: user,
  };

  const identityFiles: string[] = [];
  for (const line of raw.identityFiles) {
    const file = singleArgument(line, 'IdentityFile');
    if (file.toLowerCase() === 'none') {
      continue;
    }
    const expanded = expandTokens(file, pathTokens, 'IdentityFile', line, true);
    const path = tools.requireAbsolute(expanded, 'IdentityFile', line);
    if (!identityFiles.includes(path)) {
      identityFiles.push(path);
    }
  }
  const identityFilesAreDefaults = raw.identityFiles.length === 0;
  if (identityFilesAreDefaults) {
    identityFiles.push(
      ...DEFAULT_IDENTITY_FILES.map((name) => tools.path.join(tools.sshDirectory, name)),
    );
  }

  let identityAgent: string | undefined;
  if (raw.identityAgent !== undefined) {
    const agent = singleArgument(raw.identityAgent, 'IdentityAgent');
    if (agent === 'none' || agent === 'SSH_AUTH_SOCK') {
      identityAgent = agent;
    } else if (agent.startsWith('$')) {
      fail(
        'IdentityAgent: environment variables are not supported',
        'IdentityAgent',
        raw.identityAgent,
      );
    } else {
      identityAgent = tools.requireAbsolute(
        expandTokens(agent, pathTokens, 'IdentityAgent', raw.identityAgent, true),
        'IdentityAgent',
        raw.identityAgent,
      );
    }
  }

  const knownHostsTokens = { ...pathTokens, k: hostKeyAlias ?? alias };
  const userKnownHostsFiles = knownHostsFiles(
    raw.userKnownHostsFile,
    DEFAULT_USER_KNOWN_HOSTS_FILES,
    'UserKnownHostsFile',
    knownHostsTokens,
    tools,
  );
  const globalKnownHostsFiles = knownHostsFiles(
    raw.globalKnownHostsFile,
    [
      tools.path.join(tools.systemDirectory, 'ssh_known_hosts'),
      tools.path.join(tools.systemDirectory, 'ssh_known_hosts2'),
    ],
    'GlobalKnownHostsFile',
    knownHostsTokens,
    tools,
  );

  const lowerHost = hostName.toLowerCase();
  let knownHostsName = port === 22 ? lowerHost : `[${lowerHost}]:${port}`;
  if (hostKeyAlias !== undefined) {
    knownHostsName = hostKeyAlias;
  }
  return {
    alias,
    hostName,
    port,
    user,
    identityFiles,
    identityFilesAreDefaults,
    identitiesOnly,
    identityAgent,
    userKnownHostsFiles,
    globalKnownHostsFiles,
    hostKeyAlias,
    knownHostsName,
  };
}

/**
 * `Host` aliases for a picker: every `Host` pattern without wildcards or negation that is a
 * valid alias, in file order and without case-insensitive duplicates, from the user
 * configuration and its includes (also those inside `Host` and `Match` blocks). Unsupported or
 * unknown directives and `Match` are not reported here; resolving the alias does that.
 */
export async function listSshHostAliases(env: SshConfigEnvironment): Promise<string[]> {
  const aliases: string[] = [];
  const seen = new Set<string>();
  await walkConfig({
    env,
    tools: new PathTools(env),
    state: { filesRead: 0, ignoreUnknown: undefined },
    includeSystemConfig: false,
    onOption: () => undefined,
    onHost: (line) => {
      for (const pattern of line.args) {
        const key = pattern.toLowerCase();
        if (!isWildcardOrNegatedPattern(pattern) && isValidHostToken(pattern) && !seen.has(key)) {
          seen.add(key);
          aliases.push(pattern);
        }
      }
    },
    // Treat every block as active so that every include is read; nothing is evaluated.
    hostApplies: () => true,
    onMatch: () => true,
  });
  return aliases;
}
