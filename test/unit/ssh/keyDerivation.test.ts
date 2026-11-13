import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { KeyDerivationError, workerKeyDerivation } from '../../../src/ssh/keyDerivation';

describe('workerKeyDerivation', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A worker script that never answers, standing in for a very slow key derivation. */
  function silentWorker(): string {
    const dir = mkdtempSync(join(tmpdir(), 'vscode-deployment-kdf-'));
    dirs.push(dir);
    const file = join(dir, 'silent.js');
    writeFileSync(file, 'setInterval(() => undefined, 1000);\n');
    return file;
  }

  it('terminates the worker and rejects when the attempt is aborted', async () => {
    let created: Worker | undefined;
    const derive = workerKeyDerivation(silentWorker(), (file) => {
      created = new Worker(file);
      return created;
    });
    const abort = new AbortController();
    const result = derive(Buffer.from('pass'), Buffer.alloc(16, 1), 16, 48, abort.signal).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const exited = new Promise<void>((resolve) => {
      created?.once('exit', () => {
        resolve();
      });
    });

    abort.abort();

    expect(await result).toBeInstanceOf(KeyDerivationError);
    await exited;
  });

  it('does not start a worker for an attempt that already ended', async () => {
    let starts = 0;
    const derive = workerKeyDerivation(silentWorker(), (file) => {
      starts += 1;
      return new Worker(file);
    });
    const abort = new AbortController();
    abort.abort();
    await expect(
      derive(Buffer.from('pass'), Buffer.alloc(16), 16, 48, abort.signal),
    ).rejects.toBeInstanceOf(KeyDerivationError);
    expect(starts).toBe(0);
  });

  it('rejects when the worker cannot be created', async () => {
    const derive = workerKeyDerivation('unused', () => {
      throw new Error('cannot start a thread');
    });
    await expect(derive(Buffer.from('pass'), Buffer.alloc(16), 16, 48)).rejects.toThrow(
      'cannot start a thread',
    );
  });
});
