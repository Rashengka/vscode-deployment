import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SshConfigError } from '../../../src/ssh/sshConfig';
import { listDirectory, readRegularFile } from '../../../src/ssh/sshConfigFiles';

// Works only inside a fresh temporary directory.
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vscode-deployment-sshconfig-'));
});

afterEach(async () => {
  await chmod(join(dir, 'locked'), 0o600).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  });
  await rm(dir, { recursive: true, force: true });
});

describe('readRegularFile', () => {
  it('reads a regular file', async () => {
    await writeFile(join(dir, 'config'), 'Host example.com\n');
    expect(await readRegularFile(join(dir, 'config'))).toBe('Host example.com\n');
  });

  it('returns undefined only when the file does not exist', async () => {
    await writeFile(join(dir, 'file'), '');
    expect(await readRegularFile(join(dir, 'missing'))).toBeUndefined();
    expect(await readRegularFile(join(dir, 'file', 'below-a-file'))).toBeUndefined();
  });

  it('rejects a directory', async () => {
    await mkdir(join(dir, 'sub'));
    await expect(readRegularFile(join(dir, 'sub'))).rejects.toThrow(SshConfigError);
    await expect(readRegularFile(join(dir, 'sub'))).rejects.toThrow(/Not a regular file/);
  });

  it('rejects a file over the size limit', async () => {
    await writeFile(join(dir, 'big'), 'x'.repeat(11));
    expect(await readRegularFile(join(dir, 'big'), 11)).toHaveLength(11);
    await expect(readRegularFile(join(dir, 'big'), 10)).rejects.toThrow(/larger than 10 bytes/);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'propagates other errors such as missing permissions (POSIX, not as root)',
    async () => {
      await writeFile(join(dir, 'locked'), 'Host x\n');
      await chmod(join(dir, 'locked'), 0o000);
      await expect(readRegularFile(join(dir, 'locked'))).rejects.toMatchObject({
        code: 'EACCES',
      });
    },
  );
});

describe('listDirectory', () => {
  it('lists names, and returns undefined for a missing directory', async () => {
    await writeFile(join(dir, 'a.conf'), '');
    expect(await listDirectory(dir)).toEqual(['a.conf']);
    expect(await listDirectory(join(dir, 'missing'))).toBeUndefined();
    expect(await listDirectory(join(dir, 'a.conf'))).toBeUndefined();
  });
});
