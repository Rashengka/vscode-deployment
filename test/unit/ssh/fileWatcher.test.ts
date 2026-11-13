import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fileSignature, nodeFileWatcher, watchTarget } from '../../../src/ssh/fileWatcher';

describe('watchTarget', () => {
  it('watches the directory of an existing file, or the nearest existing ancestor', () => {
    const existing = new Set(['/home/deploy', '/home']);
    const exists = (path: string): boolean => existing.has(path);
    expect(watchTarget('/home/deploy/known_hosts', exists)).toEqual({
      directory: '/home/deploy',
      entry: 'known_hosts',
    });
    expect(watchTarget('/home/deploy/.ssh/config.d/extra', exists)).toEqual({
      directory: '/home/deploy',
      entry: '.ssh',
    });
  });
});

describe('nodeFileWatcher', { timeout: 20_000 }, () => {
  const dirs: string[] = [];
  const disposers: (() => void)[] = [];

  afterEach(() => {
    for (const dispose of disposers.splice(0)) {
      dispose();
    }
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'vscode-deployment-watch-'));
    dirs.push(dir);
    return dir;
  }

  /** What the watcher reports within `waitMs` after `act` (or until the first report). */
  async function changesAfter(files: string[], act: () => void, waitMs = 5_000): Promise<string[]> {
    const changed: string[] = [];
    const watch = nodeFileWatcher.watch(files, (file) => changed.push(file));
    disposers.push(() => {
      watch.dispose();
    });
    // Let platform events about earlier writes arrive first; they must not count.
    await new Promise((resolve) => setTimeout(resolve, 300));
    act();
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && changed.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    return changed;
  }

  it('ignores writes made just before the watch started and reports a later change', async () => {
    const dir = tempDir();
    const file = join(dir, 'known_hosts');
    writeFileSync(file, 'one\n');

    await expect(changesAfter([file], () => undefined, 1_000)).resolves.toEqual([]);
    await expect(
      changesAfter([file], () => {
        writeFileSync(file, 'two\n');
      }),
    ).resolves.toEqual([file]);
  });

  it('reports a file replaced by rename, as editors save', async () => {
    const dir = tempDir();
    const file = join(dir, 'config');
    writeFileSync(file, 'one\n');
    writeFileSync(join(dir, 'config.tmp'), 'two\n');

    await expect(
      changesAfter([file], () => {
        renameSync(join(dir, 'config.tmp'), file);
      }),
    ).resolves.toEqual([file]);
  });

  it('reports creation of a file whose directory did not exist yet', async () => {
    const dir = tempDir();
    const file = join(dir, 'conf.d', 'extra');

    const changed = await changesAfter([file], () => {
      mkdirSync(join(dir, 'conf.d'));
      writeFileSync(file, 'x\n');
    });
    expect(changed[0]).toBe(file);
  });

  it('ignores changes to other files in the same directory', async () => {
    const dir = tempDir();
    const file = join(dir, 'known_hosts');
    writeFileSync(file, 'one\n');

    await expect(
      changesAfter(
        [file],
        () => {
          writeFileSync(join(dir, 'other'), 'x');
        },
        1_000,
      ),
    ).resolves.toEqual([]);
  });

  it('reports a change made after the baseline but before the watch started', async () => {
    const dir = tempDir();
    const file = join(dir, 'config');
    writeFileSync(file, 'one\n');
    const baseline = new Map([[file, fileSignature(file)]]);
    writeFileSync(file, 'changed between reading and watching\n');

    const changed: string[] = [];
    const watch = nodeFileWatcher.watch([file], (path) => changed.push(path), baseline);
    disposers.push(() => {
      watch.dispose();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(changed).toEqual([file]);
  });

  it.skipIf(process.platform === 'win32')(
    'reports a change of the file a symbolic link points to, in another directory',
    async () => {
      const dir = tempDir();
      mkdirSync(join(dir, 'real'));
      mkdirSync(join(dir, 'ssh'));
      const target = join(dir, 'real', 'config');
      const link = join(dir, 'ssh', 'config');
      writeFileSync(target, 'one\n');
      symlinkSync(target, link);

      await expect(
        changesAfter([link], () => {
          writeFileSync(join(dir, 'real', 'config.tmp'), 'two\n');
          renameSync(join(dir, 'real', 'config.tmp'), target);
        }),
      ).resolves.toEqual([link]);
    },
  );

  it('distinguishes a missing file from an existing one', () => {
    const dir = tempDir();
    const file = join(dir, 'x');
    expect(fileSignature(file)).toBe('missing|missing');
    writeFileSync(file, 'x');
    expect(fileSignature(file)).not.toContain('missing');
  });
});
