import { execFileSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GitFilesError,
  MAX_PROJECT_FILES,
  collectProjectFiles,
  findExecutable,
  gitLsFiles,
  parseLsFiles,
} from '../../../src/mapping/projectFiles';

function isExecutableFile(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === undefined) {
      throw error;
    }
    return false;
  }
}

describe('findExecutable', () => {
  /** A file system with symbolic links: `links` maps a path to what it points at. */
  function fakeFs(files: readonly string[], links: Readonly<Record<string, string>> = {}) {
    const realpath = (path: string): string | undefined => {
      for (const [link, target] of Object.entries(links)) {
        if (path === link || path.startsWith(`${link}/`) || path.startsWith(`${link}\\`)) {
          return target + path.slice(link.length);
        }
      }
      const known = files.some(
        (file) => file === path || file.startsWith(`${path}/`) || file.startsWith(`${path}\\`),
      );
      return known ? path : undefined;
    };
    return { realpath, isExecutableFile: (file: string) => files.includes(file) };
  }

  it('takes the first absolute PATH entry that has the program, by its real path', () => {
    const fs = fakeFs(['/usr/bin/git', '/opt/git/bin/git'], { '/usr/local/bin': '/opt/git/bin' });
    expect(
      findExecutable('git', '/usr/local/bin:/usr/bin', {
        platform: 'linux',
        projectRoot: '/var/www/app',
        ...fs,
      }),
    ).toBe('/opt/git/bin/git');
  });

  it('skips relative PATH entries and folders inside the project', () => {
    const fs = fakeFs(['git', 'bin/git', '/var/www/app/bin/git', '/usr/bin/git']);
    expect(
      findExecutable('git', ['.', 'bin', '/var/www/app/bin', '/usr/bin'].join(':'), {
        platform: 'linux',
        projectRoot: '/var/www/app',
        ...fs,
      }),
    ).toBe('/usr/bin/git');
  });

  it('skips a PATH entry that is a symbolic link into the project', () => {
    const fs = fakeFs(['/var/www/app/tools/git', '/usr/bin/git'], {
      '/home/deploy/bin': '/var/www/app/tools',
    });
    expect(
      findExecutable('git', '/home/deploy/bin:/usr/bin', {
        platform: 'linux',
        projectRoot: '/var/www/app',
        ...fs,
      }),
    ).toBe('/usr/bin/git');
  });

  it('skips a program that is a symbolic link into the project', () => {
    const fs = fakeFs(['/var/www/app/git', '/usr/bin/git'], {
      '/usr/local/bin/git': '/var/www/app/git',
    });
    expect(
      findExecutable('git', '/usr/local/bin:/usr/bin', {
        platform: 'linux',
        projectRoot: '/var/www/app',
        ...fs,
      }),
    ).toBe('/usr/bin/git');
  });

  it('compares a project reached through a symbolic link by its real path', () => {
    const fs = fakeFs(['/data/app/bin/git', '/usr/bin/git'], { '/var/www/app': '/data/app' });
    expect(
      findExecutable('git', '/data/app/bin:/usr/bin', {
        platform: 'linux',
        projectRoot: '/var/www/app',
        ...fs,
      }),
    ).toBe('/usr/bin/git');
  });

  it('ignores the case of letters on macOS and Windows', () => {
    const mac = fakeFs(['/Var/WWW/App/bin/git', '/usr/bin/git']);
    expect(
      findExecutable('git', '/Var/WWW/App/bin:/usr/bin', {
        platform: 'darwin',
        projectRoot: '/var/www/app',
        ...mac,
      }),
    ).toBe('/usr/bin/git');
    const windows = fakeFs(['C:\\Work\\App\\bin\\git.exe', 'C:\\Git\\cmd\\git.exe']);
    expect(
      findExecutable('git', 'c:\\work\\app\\bin;C:\\Git\\cmd', {
        platform: 'win32',
        projectRoot: 'C:\\Work\\App',
        ...windows,
      }),
    ).toBe('C:\\Git\\cmd\\git.exe');
  });

  it('finds nothing without a usable entry', () => {
    const fs = fakeFs([]);
    expect(
      findExecutable('git', undefined, { platform: 'linux', projectRoot: '/var/www/app', ...fs }),
    ).toBeUndefined();
    expect(
      findExecutable('git', '/usr/bin', { platform: 'linux', projectRoot: '/var/www/app', ...fs }),
    ).toBeUndefined();
  });
});

describe('parseLsFiles', () => {
  it('splits NUL-separated paths with spaces, and drops names with line breaks', () => {
    expect(parseLsFiles('a.txt\0dir/b c.txt\0new\nline.txt\0')).toEqual({
      files: ['a.txt', 'dir/b c.txt'],
      truncated: false,
    });
  });

  it('drops paths that could leave the project or the root path', () => {
    expect(
      parseLsFiles(
        [
          'ok.php',
          '../../etc/passwd',
          'a/../../b',
          '/etc/passwd',
          'a\\b',
          'bell\u0007',
          'rtl\u202e',
          'src/b.php',
        ].join('\0'),
      ),
    ).toEqual({ files: ['ok.php', 'src/b.php'], truncated: false });
  });

  it('keeps at most the limit', () => {
    const output = Array.from({ length: MAX_PROJECT_FILES + 5 }, (_, i) => `f${i}`).join('\0');
    const parsed = parseLsFiles(output);
    expect(parsed.files).toHaveLength(MAX_PROJECT_FILES);
    expect(parsed.truncated).toBe(true);
  });
});

describe('gitLsFiles', () => {
  const roots: string[] = [];
  const found = findExecutable('git', process.env['PATH'], {
    platform: process.platform,
    projectRoot: tmpdir(),
    realpath: (path) => (existsSync(path) ? realpathSync(path) : undefined),
    isExecutableFile,
  });
  const git = found ?? 'git';
  // Commands that set up the test repository do not read the user's git configuration.
  const isolated = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function repository(): { root: string; repo: string } {
    const root = mkdtempSync(join(tmpdir(), 'vscode-deployment-git-'));
    roots.push(root);
    const repo = join(root, 'repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'a.txt'), 'a');
    writeFileSync(join(repo, 'src', 'b c.php'), 'b');
    writeFileSync(join(repo, 'untracked.txt'), 'u');
    execFileSync(git, ['init', '-q', '.'], { cwd: repo, env: isolated });
    execFileSync(git, ['add', 'a.txt', 'src/b c.php'], { cwd: repo, env: isolated });
    return { root, repo };
  }

  it.runIf(found !== undefined && process.platform !== 'win32')(
    'lists the tracked files and never runs the repository fsmonitor hook',
    async () => {
      const { root, repo } = repository();
      const marker = join(root, 'fsmonitor-ran');
      const hook = join(root, 'hook.sh');
      writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
      chmodSync(hook, 0o755);
      execFileSync(git, ['config', 'core.fsmonitor', hook], { cwd: repo, env: isolated });
      // Positive control: plain ls-files runs the hook of this repository.
      execFileSync(git, ['ls-files'], { cwd: repo, env: isolated, stdio: 'pipe' });
      expect(existsSync(marker)).toBe(true);
      rmSync(marker);

      const listed = await gitLsFiles(git, repo, isolated);

      expect([...listed.files].sort()).toEqual(['a.txt', 'src/b c.php']);
      expect(existsSync(marker)).toBe(false);
    },
  );

  it.runIf(found !== undefined)('lists the files below a subfolder relative to it', async () => {
    const { repo } = repository();
    const listed = await gitLsFiles(git, join(repo, 'src'), isolated);
    expect(listed.files).toEqual(['b c.php']);
  });

  it.runIf(found !== undefined)('fails with GitFilesError outside a repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vscode-deployment-nogit-'));
    roots.push(root);
    await expect(
      gitLsFiles(git, root, { ...isolated, GIT_CEILING_DIRECTORIES: tmpdir() }),
    ).rejects.toBeInstanceOf(GitFilesError);
  });

  it('is found on this machine (the tests above need it)', () => {
    expect(found).toBeDefined();
  });
});

describe('collectProjectFiles', () => {
  interface Calls {
    lsFiles: number;
    findFiles: unknown[][];
    logged: string[];
  }

  function sources(options: {
    trusted?: boolean;
    git?: string | undefined;
    gitFiles?: readonly string[] | Error;
    workspace?: readonly string[];
  }): { calls: Calls; sources: Parameters<typeof collectProjectFiles>[0] } {
    const calls: Calls = { lsFiles: 0, findFiles: [], logged: [] };
    return {
      calls,
      sources: {
        trusted: options.trusted ?? true,
        findGit: () => ('git' in options ? options.git : '/usr/bin/git'),
        gitLsFiles: () => {
          calls.lsFiles += 1;
          const result = options.gitFiles ?? ['src/a.php'];
          return result instanceof Error
            ? Promise.reject(result)
            : Promise.resolve({ files: result, truncated: false });
        },
        findFiles: (...args: unknown[]) => {
          calls.findFiles.push(args);
          return Promise.resolve(options.workspace ?? ['src/w.php']);
        },
        log: (message) => {
          calls.logged.push(message);
        },
      },
    };
  }

  it('uses git in a trusted workspace', async () => {
    const { calls, sources: s } = sources({});
    await expect(collectProjectFiles(s)).resolves.toEqual({
      files: ['src/a.php'],
      source: 'git',
      truncated: false,
    });
    expect(calls.findFiles).toEqual([]);
  });

  it('falls back to the workspace files with the default excludes, and never .git', async () => {
    const { calls, sources: s } = sources({
      git: undefined,
      workspace: ['src/w.php', '.git/config', 'sub/.git/HEAD', 'node_modules/x.js'],
    });
    const result = await collectProjectFiles(s);
    expect(result).toEqual({
      files: ['src/w.php', 'node_modules/x.js'],
      source: 'workspace',
      truncated: false,
    });
    // `undefined` keeps the files.exclude setting; `null` would switch every exclude off.
    expect(calls.findFiles).toEqual([['**/*', undefined, MAX_PROJECT_FILES + 1]]);
  });

  it('falls back when git lists no file, and says so in the log', async () => {
    const { calls, sources: s } = sources({ gitFiles: [] });
    const result = await collectProjectFiles(s);
    expect(result.source).toBe('workspace');
    expect(calls.lsFiles).toBe(1);
    expect(calls.logged.join('\n')).toContain('git ls-files listed no files');
  });

  it('falls back when git fails, and does not run git in an untrusted workspace', async () => {
    const failed = sources({ gitFiles: new GitFilesError('git ls-files failed (128).') });
    expect((await collectProjectFiles(failed.sources)).source).toBe('workspace');
    expect(failed.calls.logged).toHaveLength(1);

    const untrusted = sources({ trusted: false });
    expect((await collectProjectFiles(untrusted.sources)).source).toBe('workspace');
    expect(untrusted.calls.lsFiles).toBe(0);
  });

  it('reports that the workspace has more files than are listed', async () => {
    const many = Array.from({ length: MAX_PROJECT_FILES + 1 }, (_, i) => `f${i}`);
    const { sources: s } = sources({ git: undefined, workspace: many });
    const result = await collectProjectFiles(s);
    expect(result.files).toHaveLength(MAX_PROJECT_FILES);
    expect(result.truncated).toBe(true);
  });
});
