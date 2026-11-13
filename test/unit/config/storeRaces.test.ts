/**
 * Situations that need another window to act at an exact moment; the modules involved are
 * wrapped so that a test can make that happen.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as atomicWrite from '../../../src/config/atomicWrite';
import * as migrate from '../../../src/config/migrate';
import { emptyConfig } from '../../../src/config/model';
import { disambiguatedName, encodeProjectPath } from '../../../src/config/paths';
import {
  UnsafeConfigError,
  canonicalProjectPath,
  ensureConfigFile,
  loadConfig,
  type StoreOptions,
} from '../../../src/config/store';
import { sftpServer } from './fixtures';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, mkdir: vi.fn(actual.mkdir) };
});

vi.mock('../../../src/config/atomicWrite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/config/atomicWrite')>();
  return { ...actual, createFileExclusive: vi.fn(actual.createFileExclusive) };
});

vi.mock('../../../src/config/migrate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/config/migrate')>();
  return { ...actual, migrateConfig: vi.fn(actual.migrateConfig) };
});

const posixOnly = it.skipIf(process.platform === 'win32');

let sandbox: string;
let options: StoreOptions;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'vscode-deployment-unit-'));
  options = { root: join(sandbox, 'config', 'vscode-deployment') };
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

async function makeProject(...segments: string[]): Promise<string> {
  const folder = join(sandbox, 'projects', ...segments);
  mkdirSync(folder, { recursive: true });
  return canonicalProjectPath(folder);
}

describe('races with another window', () => {
  it('never opens the file of a colliding project that was created first', async () => {
    const first = await makeProject('a', 'b-c');
    const second = await makeProject('a-b', 'c');
    const foreign = `${JSON.stringify(emptyConfig(first), null, 2)}\n`;
    // The first project's window creates the shared file just before this one does.
    vi.mocked(atomicWrite.createFileExclusive).mockImplementationOnce((target) => {
      writeFileSync(target, foreign, { mode: 0o600 });
      return Promise.resolve(false);
    });

    const { file, created } = await ensureConfigFile(second, options);

    expect(created).toBe(true);
    expect(dirname(file)).toBe(join(options.root, 'projects', disambiguatedName(second)));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(emptyConfig(second));
    const shared = join(options.root, 'projects', encodeProjectPath(first), 'config.json');
    expect(readFileSync(shared, 'utf8')).toBe(foreign);
  });

  it('checks the project again after migration', async () => {
    const projectPath = await makeProject('app');
    const other = await makeProject('other');
    await ensureConfigFile(projectPath, options);
    vi.mocked(migrate.migrateConfig).mockReturnValueOnce({
      ok: true,
      value: { ...emptyConfig(other), servers: [sftpServer()] },
      migratedFrom: null,
    });

    expect(await loadConfig(projectPath, options)).toMatchObject({
      status: 'invalid',
      errors: ['projectPath: belongs to a different project folder'],
    });
  });

  posixOnly('checks the folder again after creating it', async () => {
    const projectPath = await makeProject('app');
    const elsewhere = join(sandbox, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o700 });
    // Another process puts a symbolic link where the project folder is about to be created.
    vi.mocked(fsPromises.mkdir).mockImplementationOnce((target) => {
      mkdirSync(dirname(String(target)), { recursive: true, mode: 0o700 });
      symlinkSync(elsewhere, String(target));
      return Promise.resolve(undefined);
    });

    await expect(ensureConfigFile(projectPath, options)).rejects.toBeInstanceOf(UnsafeConfigError);
    expect(() => readFileSync(join(elsewhere, 'config.json'))).toThrow();
  });
});
