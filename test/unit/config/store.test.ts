import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { currentUid } from '../../../src/config/fileSafety';
import { emptyConfig, type DeploymentConfig } from '../../../src/config/model';
import { disambiguatedName, encodeProjectPath } from '../../../src/config/paths';
import {
  InvalidConfigError,
  UnownedConfigError,
  UnsafeConfigError,
  canonicalProjectPath,
  ensureConfigFile,
  isSameProject,
  loadConfig,
  loadState,
  saveConfig,
  updateState,
  type StoreOptions,
} from '../../../src/config/store';
import { sftpServer } from './fixtures';

const posixOnly = it.skipIf(process.platform === 'win32');

let sandbox: string;
let root: string;
let options: StoreOptions;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'vscode-deployment-unit-'));
  root = join(sandbox, 'config', 'vscode-deployment');
  options = { root };
});

afterEach(() => {
  // Restore permissions changed by a test, so that the sandbox can always be removed.
  if (process.platform !== 'win32') {
    for (const entry of readdirSync(sandbox, { recursive: true, encoding: 'utf8' })) {
      const full = join(sandbox, entry);
      if (existsSync(full) && statSync(full).isDirectory()) {
        chmodSync(full, 0o700);
      }
    }
  }
  rmSync(sandbox, { recursive: true, force: true });
});

async function makeProject(...segments: string[]): Promise<string> {
  const folder = join(sandbox, 'projects', ...segments);
  mkdirSync(folder, { recursive: true });
  return canonicalProjectPath(folder);
}

function withServer(projectPath: string): DeploymentConfig {
  return { ...emptyConfig(projectPath), servers: [sftpServer()] };
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe('canonical project path', () => {
  it('resolves to the real path (on macOS /var becomes /private/var)', async () => {
    const folder = join(sandbox, 'projects', 'app');
    mkdirSync(folder, { recursive: true });
    const canonical = await canonicalProjectPath(folder);
    expect(canonical).toBe(realpathSync.native(folder));
    if (process.platform === 'darwin' && folder.startsWith('/var/')) {
      expect(canonical).toBe(`/private${folder}`);
    }
  });

  posixOnly('resolves a symbolic link to the same configuration', async () => {
    const projectPath = await makeProject('app');
    const link = join(sandbox, 'link-to-app');
    symlinkSync(projectPath, link);
    await saveConfig(projectPath, withServer(projectPath), options);

    const viaLink = await canonicalProjectPath(link);
    expect(viaLink).toBe(projectPath);
    expect((await loadConfig(viaLink, options)).status).toBe('ok');
  });

  it('treats a different spelling of the case as the same folder exactly when the file system does', async () => {
    const projectPath = await makeProject('CaseProject');
    const lowerCase = join(dirname(projectPath), basename(projectPath).toLowerCase());
    const caseInsensitive = existsSync(lowerCase);
    await saveConfig(projectPath, withServer(projectPath), options);

    expect(await isSameProject(lowerCase, projectPath)).toBe(caseInsensitive);
    if (caseInsensitive) {
      // APFS and NTFS by default: every spelling maps to one canonical path and configuration.
      const canonical = await canonicalProjectPath(lowerCase);
      expect(canonical).toBe(projectPath);
      expect(encodeProjectPath(canonical)).toBe(encodeProjectPath(projectPath));
      expect((await loadConfig(canonical, options)).status).toBe('ok');
    } else {
      await expect(canonicalProjectPath(lowerCase)).rejects.toThrow();
    }
  });

  it('accepts a stored path in another case on a case-insensitive file system', async () => {
    const projectPath = await makeProject('MixedCase');
    const upper = projectPath.toUpperCase();
    const caseInsensitive = existsSync(upper);
    const dir = join(root, 'projects', encodeProjectPath(projectPath));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ ...emptyConfig(upper), servers: [sftpServer()] }),
      { mode: 0o600 },
    );
    const result = await loadConfig(projectPath, options);
    // On a case-sensitive file system the stored path names another (missing) folder, so the
    // file belongs to someone else and this project gets the disambiguated folder.
    expect(result.status).toBe(caseInsensitive ? 'ok' : 'missing');
  });
});

describe('ensureConfigFile', () => {
  it('creates an empty valid configuration that loads', async () => {
    const projectPath = await makeProject('app');
    const { file, created } = await ensureConfigFile(projectPath, options);

    expect(created).toBe(true);
    expect(file).toBe(join(root, 'projects', encodeProjectPath(projectPath), 'config.json'));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(emptyConfig(projectPath));
    expect(await loadConfig(projectPath, options)).toEqual({
      status: 'ok',
      dir: dirname(file),
      config: emptyConfig(projectPath),
      migratedFrom: null,
    });
  });

  it('never replaces an existing file', async () => {
    const projectPath = await makeProject('app');
    const { file } = await ensureConfigFile(projectPath, options);
    const edited = `${readFileSync(file, 'utf8')}\n\n`;
    writeFileSync(file, edited);

    expect(await ensureConfigFile(projectPath, options)).toEqual({ file, created: false });
    expect(readFileSync(file, 'utf8')).toBe(edited);
    expect(readdirSync(dirname(file))).toEqual(['config.json']);
  });

  posixOnly('creates folders with mode 0700 and the file with mode 0600', async () => {
    const projectPath = await makeProject('app');
    const { file } = await ensureConfigFile(projectPath, options);

    expect(mode(root)).toBe(0o700);
    expect(mode(join(root, 'projects'))).toBe(0o700);
    expect(mode(dirname(file))).toBe(0o700);
    expect(mode(file)).toBe(0o600);
  });
});

describe('saveConfig and loadConfig', () => {
  it('reports a missing configuration', async () => {
    const projectPath = await makeProject('app');
    expect(await loadConfig(projectPath, options)).toEqual({
      status: 'missing',
      dir: join(root, 'projects', encodeProjectPath(projectPath)),
    });
  });

  it('round-trips a configuration and leaves no temporary files', async () => {
    const projectPath = await makeProject('app');
    const config = withServer(projectPath);
    const file = await saveConfig(projectPath, config, options);
    await saveConfig(projectPath, config, options);

    const result = await loadConfig(projectPath, options);
    expect(result).toMatchObject({ status: 'ok', config });
    expect(readdirSync(dirname(file))).toEqual(['config.json']);
  });

  posixOnly('keeps mode 0600 when replacing the file', async () => {
    const projectPath = await makeProject('app');
    const file = await saveConfig(projectPath, withServer(projectPath), options);
    await saveConfig(projectPath, emptyConfig(projectPath), options);
    expect(mode(file)).toBe(0o600);
  });

  it('refuses to save an invalid configuration and keeps the previous file', async () => {
    const projectPath = await makeProject('app');
    const file = await saveConfig(projectPath, withServer(projectPath), options);
    const before = readFileSync(file, 'utf8');
    const invalid = {
      ...emptyConfig(projectPath),
      servers: [sftpServer({ rootPath: 'relative' })],
    };

    await expect(saveConfig(projectPath, invalid, options)).rejects.toBeInstanceOf(
      InvalidConfigError,
    );
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('refuses to save a configuration of another project', async () => {
    const projectPath = await makeProject('app');
    const other = await makeProject('other');
    await expect(saveConfig(projectPath, withServer(other), options)).rejects.toThrow(
      'belongs to a different project folder',
    );
  });

  it('reports invalid JSON, invalid content and a newer version', async () => {
    const projectPath = await makeProject('app');
    const { file } = await ensureConfigFile(projectPath, options);

    writeFileSync(file, `{ "projectPath": ${JSON.stringify(projectPath)}, not json`);
    expect(await loadConfig(projectPath, options)).toMatchObject({
      status: 'invalid',
      errors: [expect.stringMatching(/^not valid JSON/) as unknown],
    });

    writeFileSync(file, JSON.stringify({ ...emptyConfig(projectPath), password: 'x' }));
    expect(await loadConfig(projectPath, options)).toMatchObject({
      status: 'invalid',
      errors: ['config.password: unknown property'],
    });

    writeFileSync(file, JSON.stringify({ ...emptyConfig(projectPath), version: 99 }));
    expect(await loadConfig(projectPath, options)).toMatchObject({
      status: 'invalid',
      errors: [expect.stringContaining('newer version') as unknown],
    });
  });

  it('accepts a byte order mark written by an editor', async () => {
    const projectPath = await makeProject('app');
    const { file } = await ensureConfigFile(projectPath, options);
    writeFileSync(file, `\uFEFF${JSON.stringify(emptyConfig(projectPath))}`);
    expect((await loadConfig(projectPath, options)).status).toBe('ok');
  });
});

describe('encoding collisions', () => {
  it('gives each project its own folder when the encoded names collide', async () => {
    const first = await makeProject('a', 'b-c');
    const second = await makeProject('a-b', 'c');
    expect(encodeProjectPath(first)).toBe(encodeProjectPath(second));

    const firstFile = await saveConfig(first, withServer(first), options);
    const secondFile = await saveConfig(second, withServer(second), options);

    expect(basename(dirname(firstFile))).toBe(encodeProjectPath(first));
    expect(basename(dirname(secondFile))).toBe(disambiguatedName(second));
    expect(await loadConfig(first, options)).toMatchObject({
      status: 'ok',
      config: { projectPath: first },
    });
    expect(await loadConfig(second, options)).toMatchObject({
      status: 'ok',
      config: { projectPath: second },
    });
  });

  it('never loads the configuration of another project from the encoded folder', async () => {
    const projectPath = await makeProject('app');
    const dir = join(root, 'projects', encodeProjectPath(projectPath));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const foreign = withServer('/var/www/elsewhere');
    writeFileSync(join(dir, 'config.json'), JSON.stringify(foreign), { mode: 0o600 });

    expect(await loadConfig(projectPath, options)).toEqual({
      status: 'missing',
      dir: join(root, 'projects', disambiguatedName(projectPath)),
    });
    const { file } = await ensureConfigFile(projectPath, options);
    expect(dirname(file)).toBe(join(root, 'projects', disambiguatedName(projectPath)));
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))).toEqual(foreign);
  });

  it('keeps using the disambiguated folder after the other project is gone', async () => {
    const first = await makeProject('a', 'b-c');
    const second = await makeProject('a-b', 'c');
    await saveConfig(first, withServer(first), options);
    const secondFile = await saveConfig(second, withServer(second), options);
    rmSync(join(root, 'projects', encodeProjectPath(first)), { recursive: true });

    expect(await loadConfig(second, options)).toMatchObject({
      status: 'ok',
      dir: dirname(secondFile),
    });
  });
});

describe('ownership and permission checks', () => {
  async function savedProject(): Promise<{ projectPath: string; file: string }> {
    const projectPath = await makeProject('app');
    const file = await saveConfig(projectPath, withServer(projectPath), options);
    return { projectPath, file };
  }

  posixOnly('does not load from a project folder writable by others', async () => {
    const { projectPath, file } = await savedProject();
    chmodSync(dirname(file), 0o777);

    const result = await loadConfig(projectPath, options);
    expect(result).toEqual({
      status: 'unsafe',
      problem: `${dirname(file)} is writable by other users (mode 777)`,
    });
  });

  posixOnly('does not load when the root or projects folder is writable by the group', async () => {
    const { projectPath } = await savedProject();
    chmodSync(join(root, 'projects'), 0o770);
    expect((await loadConfig(projectPath, options)).status).toBe('unsafe');
    chmodSync(join(root, 'projects'), 0o700);
    chmodSync(root, 0o720);
    expect((await loadConfig(projectPath, options)).status).toBe('unsafe');
  });

  posixOnly('does not load a config file writable by others', async () => {
    const { projectPath, file } = await savedProject();
    chmodSync(file, 0o666);
    expect(await loadConfig(projectPath, options)).toEqual({
      status: 'unsafe',
      problem: `${file} is writable by other users (mode 666)`,
    });
  });

  posixOnly('does not follow a symbolic link for the config file', async () => {
    const { projectPath, file } = await savedProject();
    const elsewhere = join(sandbox, 'elsewhere.json');
    writeFileSync(elsewhere, readFileSync(file), { mode: 0o600 });
    rmSync(file);
    symlinkSync(elsewhere, file);

    expect(await loadConfig(projectPath, options)).toEqual({
      status: 'unsafe',
      problem: `${file} is a symbolic link`,
    });
  });

  posixOnly('does not use a project folder that is a symbolic link', async () => {
    const { projectPath, file } = await savedProject();
    const dir = dirname(file);
    const moved = join(sandbox, 'moved');
    mkdirSync(moved, { mode: 0o700 });
    writeFileSync(join(moved, 'config.json'), readFileSync(file), { mode: 0o600 });
    rmSync(dir, { recursive: true });
    symlinkSync(moved, dir);

    expect(await loadConfig(projectPath, options)).toEqual({
      status: 'unsafe',
      problem: `${dir} is a symbolic link`,
    });
  });

  posixOnly('does not load files of another owner', async () => {
    const { projectPath } = await savedProject();
    const uid = currentUid();
    expect(uid).not.toBeNull();
    const result = await loadConfig(projectPath, { ...options, uid: (uid ?? 0) + 1 });
    expect(result).toMatchObject({ status: 'unsafe' });
    expect(result.status === 'unsafe' && result.problem).toMatch(/belongs to another user$/);
  });

  posixOnly('refuses to write into an unsafe folder', async () => {
    const { projectPath, file } = await savedProject();
    const before = readFileSync(file, 'utf8');
    chmodSync(dirname(file), 0o777);

    await expect(saveConfig(projectPath, emptyConfig(projectPath), options)).rejects.toBeInstanceOf(
      UnsafeConfigError,
    );
    await expect(ensureConfigFile(projectPath, options)).rejects.toBeInstanceOf(UnsafeConfigError);
    await expect(
      updateState(
        projectPath,
        [{ serverId: 'a', remotePath: 'x', record: { mtime: 1, size: 1, uploadedAt: 1 } }],
        options,
      ),
    ).rejects.toBeInstanceOf(UnsafeConfigError);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(existsSync(join(dirname(file), 'state.json'))).toBe(false);
  });
});

describe('state.json', () => {
  const record = (size: number) => ({ mtime: 1_700_000_000, size, uploadedAt: 1_700_000_000_000 });

  async function configured(...segments: string[]): Promise<string> {
    const projectPath = await makeProject(...segments);
    await saveConfig(projectPath, withServer(projectPath), options);
    return projectPath;
  }

  it('is empty when missing, and needs a configuration before it is written', async () => {
    const projectPath = await makeProject('app');
    expect(await loadState(projectPath, options)).toEqual({ version: 1, projectPath, servers: {} });
    await expect(
      updateState(projectPath, [{ serverId: 'a', remotePath: 'one', record: record(1) }], options),
    ).rejects.toBeInstanceOf(UnownedConfigError);
    expect(existsSync(join(root, 'projects', encodeProjectPath(projectPath), 'state.json'))).toBe(
      false,
    );
  });

  it('merges writes from two windows instead of overwriting', async () => {
    const projectPath = await configured('app');
    // Each window only knows its own upload; neither passes the other's entries.
    await updateState(
      projectPath,
      [{ serverId: 'a', remotePath: 'one', record: record(1) }],
      options,
    );
    await updateState(
      projectPath,
      [{ serverId: 'a', remotePath: 'two', record: record(2) }],
      options,
    );
    await updateState(
      projectPath,
      [{ serverId: 'b', remotePath: 'one', record: record(3) }],
      options,
    );

    expect(await loadState(projectPath, options)).toEqual({
      version: 1,
      projectPath,
      servers: { a: { one: record(1), two: record(2) }, b: { one: record(3) } },
    });
  });

  it('does not overwrite a state file it cannot read', async () => {
    const projectPath = await configured('app');
    await updateState(
      projectPath,
      [{ serverId: 'a', remotePath: 'one', record: record(1) }],
      options,
    );
    const file = join(root, 'projects', encodeProjectPath(projectPath), 'state.json');
    writeFileSync(file, '{ broken');

    await expect(loadState(projectPath, options)).rejects.toBeInstanceOf(InvalidConfigError);
    await expect(
      updateState(projectPath, [{ serverId: 'a', remotePath: 'two', record: record(2) }], options),
    ).rejects.toBeInstanceOf(InvalidConfigError);
    expect(readFileSync(file, 'utf8')).toBe('{ broken');
  });

  it('never adopts the history of a colliding project left in the shared folder', async () => {
    const first = await makeProject('a', 'b-c');
    const second = await configured('a-b', 'c');
    // The second project took the shared folder; a history of the first one is still there.
    const dir = join(root, 'projects', encodeProjectPath(second));
    const stray = JSON.stringify({
      version: 1,
      projectPath: first,
      servers: { a: { x: record(9) } },
    });
    writeFileSync(join(dir, 'state.json'), stray, { mode: 0o600 });

    await expect(loadState(second, options)).rejects.toThrow('belongs to a different project');
    await expect(
      updateState(second, [{ serverId: 'a', remotePath: 'y', record: record(1) }], options),
    ).rejects.toThrow('belongs to a different project');
    expect(readFileSync(join(dir, 'state.json'), 'utf8')).toBe(stray);
  });

  it('is only read from the folder whose configuration belongs to the project', async () => {
    const first = await configured('a', 'b-c');
    const second = await configured('a-b', 'c');
    await updateState(first, [{ serverId: 'a', remotePath: 'x', record: record(1) }], options);

    expect(await loadState(second, options)).toEqual({
      version: 1,
      projectPath: second,
      servers: {},
    });
  });

  posixOnly('is written with mode 0600', async () => {
    const projectPath = await configured('app');
    await updateState(
      projectPath,
      [{ serverId: 'a', remotePath: 'one', record: record(1) }],
      options,
    );
    expect(mode(join(root, 'projects', encodeProjectPath(projectPath), 'state.json'))).toBe(0o600);
  });
});

describe('a configuration whose project cannot be told', () => {
  const unreadable = '{ "projectPath": oops }';

  async function collidingPair(): Promise<{ first: string; second: string; shared: string }> {
    const first = await makeProject('a', 'b-c');
    const second = await makeProject('a-b', 'c');
    const shared = join(root, 'projects', encodeProjectPath(first), 'config.json');
    return { first, second, shared };
  }

  function writeShared(shared: string, content: string): void {
    mkdirSync(dirname(shared), { recursive: true, mode: 0o700 });
    writeFileSync(shared, content, { mode: 0o600 });
  }

  it.each([
    ['unparsable JSON', unreadable],
    ['JSON without projectPath', JSON.stringify({ version: 1, servers: [] })],
    ['projectPath that is not a string', JSON.stringify({ version: 1, projectPath: 7 })],
  ])(
    'is never opened, written or repaired by any project in the shared folder (%s)',
    async (_, content) => {
      const { first, second, shared } = await collidingPair();
      await saveConfig(first, withServer(first), options);
      writeShared(shared, content);

      for (const project of [first, second]) {
        const result = await loadConfig(project, options);
        expect(result).toMatchObject({ status: 'invalid', dir: dirname(shared) });
        expect(result.status === 'invalid' && result.errors[0]).toContain(
          'does not say which project folder it belongs to',
        );
        await expect(ensureConfigFile(project, options)).rejects.toBeInstanceOf(UnownedConfigError);
        await expect(saveConfig(project, withServer(project), options)).rejects.toBeInstanceOf(
          UnownedConfigError,
        );
        await expect(loadState(project, options)).rejects.toBeInstanceOf(UnownedConfigError);
      }
      expect(readFileSync(shared, 'utf8')).toBe(content);
      expect(readdirSync(join(root, 'projects'))).toEqual([basename(dirname(shared))]);
    },
  );

  it('stays with its project when the syntax error leaves projectPath readable', async () => {
    const { first, second, shared } = await collidingPair();
    const broken = `{\n  "version": 1,\n  "projectPath": ${JSON.stringify(first)},\n  "servers": [,]\n}`;
    writeShared(shared, broken);

    // The owner gets its broken file to repair it; the other project never sees it.
    expect(await loadConfig(first, options)).toMatchObject({ status: 'invalid' });
    expect(await ensureConfigFile(first, options)).toEqual({ file: shared, created: false });
    const other = await ensureConfigFile(second, options);
    expect(other.created).toBe(true);
    expect(dirname(other.file)).toBe(join(root, 'projects', disambiguatedName(second)));
    expect(readFileSync(shared, 'utf8')).toBe(broken);
  });

  it('is the own to repair in the folder named with its hash', async () => {
    const projectPath = await makeProject('app');
    const own = join(root, 'projects', disambiguatedName(projectPath), 'config.json');
    writeShared(own, unreadable);

    expect(await loadConfig(projectPath, options)).toMatchObject({
      status: 'invalid',
      dir: dirname(own),
    });
    expect(await ensureConfigFile(projectPath, options)).toEqual({ file: own, created: false });
    await saveConfig(projectPath, withServer(projectPath), options);
    expect((await loadConfig(projectPath, options)).status).toBe('ok');
  });

  it('never quotes the file content in the error', async () => {
    const projectPath = await makeProject('app');
    const { file } = await ensureConfigFile(projectPath, options);
    const secret = `pw${randomBytes(6).toString('hex')}`;
    writeFileSync(
      file,
      `{\n  "version": 1,\n  "projectPath": ${JSON.stringify(projectPath)},\n  "servers": ${secret}\n}`,
    );

    const result = await loadConfig(projectPath, options);
    expect(result).toMatchObject({ status: 'invalid' });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret.slice(0, 4));
  });
});

describe('loadConfig never throws for unusable input', () => {
  it('treats a stored projectPath below a file as another project', async () => {
    const projectPath = await makeProject('app');
    const aFile = join(sandbox, 'plain-file');
    writeFileSync(aFile, 'x');
    const dir = join(root, 'projects', encodeProjectPath(projectPath));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'config.json'), JSON.stringify(withServer(join(aFile, 'below'))), {
      mode: 0o600,
    });

    expect(await loadConfig(projectPath, options)).toEqual({
      status: 'missing',
      dir: join(root, 'projects', disambiguatedName(projectPath)),
    });
  });

  it('reports a project folder that does not exist', async () => {
    expect(await loadConfig(join(sandbox, 'gone'), options)).toEqual({
      status: 'invalid',
      dir: null,
      errors: ['the project folder cannot be resolved (ENOENT)'],
    });
  });

  posixOnly('accepts any spelling of the project folder, such as a symbolic link', async () => {
    const projectPath = await makeProject('app');
    const link = join(sandbox, 'link-to-app');
    symlinkSync(projectPath, link);

    const { file } = await ensureConfigFile(link, options);
    expect(file).toBe(join(root, 'projects', encodeProjectPath(projectPath), 'config.json'));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(emptyConfig(projectPath));
    await saveConfig(link, withServer(projectPath), options);
    expect(await loadConfig(link, options)).toMatchObject({
      status: 'ok',
      config: { projectPath },
    });
  });

  it.skipIf(process.platform === 'win32' || currentUid() === 0)(
    'reports a config file it may not read as unsafe',
    async () => {
      const projectPath = await makeProject('app');
      const { file } = await ensureConfigFile(projectPath, options);
      chmodSync(file, 0o000);
      expect(await loadConfig(projectPath, options)).toEqual({
        status: 'unsafe',
        problem: `${file} cannot be read (permission denied)`,
      });
    },
  );

  posixOnly(
    'reports a named pipe in place of the config file without blocking',
    async () => {
      const projectPath = await makeProject('app');
      const { file } = await ensureConfigFile(projectPath, options);
      rmSync(file);
      execFileSync('mkfifo', ['-m', '600', file]);

      expect(await loadConfig(projectPath, options)).toEqual({
        status: 'unsafe',
        problem: `${file} is not a regular file`,
      });
    },
    5_000,
  );

  posixOnly('reports a config file with a second hard link as unsafe', async () => {
    const projectPath = await makeProject('app');
    const { file } = await ensureConfigFile(projectPath, options);
    linkSync(file, join(sandbox, 'second-name.json'));

    expect(await loadConfig(projectPath, options)).toEqual({
      status: 'unsafe',
      problem: `${file} has more than one hard link`,
    });
  });
});
