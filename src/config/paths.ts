/**
 * Where the configuration of a project lives:
 *
 * - POSIX: `${XDG_CONFIG_HOME:-~/.config}/vscode-deployment/projects/<encoded>/`
 * - Windows: `%APPDATA%\vscode-deployment\projects\<encoded>\`
 *
 * `<encoded>` is the canonical project path with separators replaced by `-`
 * (`/var/www/app` -> `-var-www-app`, `C:\www\app` -> `C--www-app`). The encoding is not
 * injective, so `config.json` also stores the original path; when the encoded folder already
 * belongs to another project, a variant with a hash suffix is used instead (see `store.ts`).
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';

export const APP_DIR_NAME = 'vscode-deployment';
export const PROJECTS_DIR_NAME = 'projects';

/**
 * Overrides the configuration root (the `vscode-deployment` folder itself). Used by the tests,
 * so that they never touch the real configuration of the user running them.
 */
export const CONFIG_DIR_ENV = 'VSCODE_DEPLOYMENT_CONFIG_DIR';

/** File names are limited to 255 bytes on common file systems; stay well below that. */
const MAX_ENCODED_BYTES = 160;
const HASH_LENGTH = 16;

export interface ConfigRootInput {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homedir: string;
}

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** The `vscode-deployment` folder that holds the `projects` folder. */
export function configRoot({ platform, env, homedir }: ConfigRootInput): string {
  const api = pathApi(platform);
  const override = env[CONFIG_DIR_ENV];
  if (override !== undefined && override !== '') {
    if (!api.isAbsolute(override)) {
      throw new Error(`${CONFIG_DIR_ENV} must be an absolute path.`);
    }
    return api.normalize(override);
  }
  if (platform === 'win32') {
    const appData = env['APPDATA'];
    const base =
      appData !== undefined && api.isAbsolute(appData)
        ? appData
        : api.join(homedir, 'AppData', 'Roaming');
    return api.join(base, APP_DIR_NAME);
  }
  // The XDG specification says that a relative value must be ignored.
  const xdg = env['XDG_CONFIG_HOME'];
  const base = xdg !== undefined && api.isAbsolute(xdg) ? xdg : api.join(homedir, '.config');
  return api.join(base, APP_DIR_NAME);
}

export function projectsDir(root: string, platform: NodeJS.Platform): string {
  return pathApi(platform).join(root, PROJECTS_DIR_NAME);
}

/**
 * Replaces path separators, the drive colon and control characters with `-`. The result is a
 * valid file name on every platform the extension supports.
 */
export function encodeProjectPath(projectPath: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are replaced on purpose
  const encoded = projectPath.replace(/[\\/:\u0000-\u001f\u007f]/g, '-');
  if (Buffer.byteLength(encoded, 'utf8') <= MAX_ENCODED_BYTES) {
    return encoded;
  }
  // Too long for a file name: keep a readable prefix and make it unique with the hash.
  const prefixLimit = MAX_ENCODED_BYTES - HASH_LENGTH - 1;
  let prefix = '';
  let prefixBytes = 0;
  for (const char of encoded) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (prefixBytes + charBytes > prefixLimit) {
      break;
    }
    prefix += char;
    prefixBytes += charBytes;
  }
  return `${prefix}-${pathHash(projectPath)}`;
}

/** The folder name used when the plain encoded name already belongs to another project. */
export function disambiguatedName(projectPath: string): string {
  const encoded = encodeProjectPath(projectPath);
  const hash = pathHash(projectPath);
  return encoded.endsWith(`-${hash}`) ? `${encoded}-2` : `${encoded}-${hash}`;
}

function pathHash(projectPath: string): string {
  return createHash('sha256').update(projectPath, 'utf8').digest('hex').slice(0, HASH_LENGTH);
}
