import { describe, expect, it } from 'vitest';
import type { SftpServer } from '../../../src/config/model';
import {
  VERIFY_SAMPLE_SIZE,
  overallPassed,
  planVerification,
  sampleOf,
  verdictText,
  verifyMappings,
} from '../../../src/mapping/verify';
import type { RemoteStat } from '../../../src/transport/deploymentTarget';
import { sftpServer } from '../config/fixtures';

/** A deterministic source of "random" numbers: always the first candidate. */
const first = (): number => 0;

function files(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}.php`);
}

function server(overrides: Partial<SftpServer> = {}): SftpServer {
  return sftpServer({
    rootPath: '/home/deploy',
    mappings: [{ localPath: '.', deploymentPath: 'www/app' }],
    excludedLocalPaths: [],
    excludedRemotePaths: [],
    ...overrides,
  });
}

function defined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('expected a value');
  }
  return value;
}

const FILE: RemoteStat = { type: 'file', size: 1, mtime: 0, mode: 0o644 };

describe('sampleOf', () => {
  it('takes every item when there are not more than asked for', () => {
    expect(sampleOf(['a', 'b'], 20, (max) => Math.floor(Math.random() * max)).sort()).toEqual([
      'a',
      'b',
    ]);
  });

  it('takes exactly n different items', () => {
    const items = files('src/', 500);
    const sample = sampleOf(items, 20, (max) => Math.floor(Math.random() * max));
    expect(sample).toHaveLength(20);
    expect(new Set(sample).size).toBe(20);
    expect(sample.every((item) => items.includes(item))).toBe(true);
  });

  it('draws with the random source, so every item can be picked', () => {
    const items = ['a', 'b', 'c', 'd'];
    const last = (max: number): number => max - 1;
    expect(sampleOf(items, 1, first)).toEqual(['a']);
    expect(sampleOf(items, 1, last)).toEqual(['d']);
  });

  it('does not change the list it samples', () => {
    const items = ['a', 'b', 'c'];
    sampleOf(items, 2, first);
    expect(items).toEqual(['a', 'b', 'c']);
  });
});

describe('planVerification', () => {
  it('samples 20 files by default and maps them to the server', () => {
    const plan = planVerification(server(), files('src/', 100), VERIFY_SAMPLE_SIZE, first);
    expect(plan).toHaveLength(1);
    expect(plan[0]?.files).toHaveLength(20);
    expect(plan[0]?.available).toBe(100);
    expect(plan[0]?.files[0]).toEqual({
      local: 'src/0.php',
      remote: '/home/deploy/www/app/src/0.php',
    });
  });

  it('leaves out excluded local and remote paths', () => {
    const plan = planVerification(
      server({
        mappings: [{ localPath: '.', deploymentPath: 'www/app' }],
        excludedLocalPaths: ['vendor'],
        excludedRemotePaths: ['www/app/cache'],
      }),
      ['vendor/a.php', 'cache/b.php', 'src/c.php'],
      20,
      first,
    );
    expect(plan[0]?.files.map((file) => file.local)).toEqual(['src/c.php']);
    expect(plan[0]?.available).toBe(1);
  });

  it('samples each mapping on its own, by the longest local path', () => {
    const plan = planVerification(
      server({
        mappings: [
          { localPath: '.', deploymentPath: 'www/app' },
          { localPath: 'public', deploymentPath: 'www/static' },
        ],
      }),
      [...files('src/', 30), ...files('public/', 5)],
      20,
      first,
    );
    expect(plan.map((entry) => [entry.mappingIndex, entry.files.length, entry.available])).toEqual([
      [0, 20, 30],
      [1, 5, 5],
    ]);
    expect(plan[1]?.files[0]?.remote).toBe('/home/deploy/www/static/0.php');
  });

  it('lists a mapping without files with an empty sample', () => {
    const plan = planVerification(
      server({ mappings: [{ localPath: 'missing', deploymentPath: 'x' }] }),
      ['src/a.php'],
      20,
      first,
    );
    expect(plan).toEqual([
      {
        mappingIndex: 0,
        localPath: 'missing',
        deploymentPath: 'x',
        files: [],
        available: 0,
        mapped: 0,
        shadowedBy: null,
      },
    ]);
  });
});

describe('verifyMappings', () => {
  function target(existing: ReadonlySet<string>): {
    stat(path: string): Promise<RemoteStat | null>;
  } {
    return {
      stat: (path) => Promise.resolve(existing.has(path) ? FILE : null),
    };
  }

  it('counts the files found on the server and lists the missing ones', async () => {
    const plan = planVerification(server(), files('src/', 20), 20, first);
    const present = new Set(plan[0]?.files.slice(0, 18).map((file) => file.remote));
    const [check] = await verifyMappings(target(present), plan);
    expect(check?.checked).toBe(20);
    expect(check?.found).toBe(18);
    expect(check?.missing).toHaveLength(2);
    expect(check?.verdict).toBe('correct');
    expect(verdictText(defined(check))).toBe('18/20 files found – mapping looks correct');
  });

  it('calls a mapping with few files found probably wrong', async () => {
    const plan = planVerification(server(), files('src/', 20), 20, first);
    const present = new Set(plan[0]?.files.slice(0, 2).map((file) => file.remote));
    const [check] = await verifyMappings(target(present), plan);
    expect(check?.verdict).toBe('wrong');
    expect(verdictText(defined(check))).toBe('2/20 files found – mapping is probably wrong');
  });

  it('does not count a directory where a file belongs', async () => {
    const plan = planVerification(server(), ['src/a.php'], 20, first);
    const [check] = await verifyMappings(
      { stat: () => Promise.resolve({ ...FILE, type: 'directory' as const }) },
      plan,
    );
    expect(check?.found).toBe(0);
  });

  it('reports a mapping without files to check', async () => {
    const [check] = await verifyMappings(target(new Set()), [
      {
        mappingIndex: 0,
        localPath: 'x',
        deploymentPath: 'y',
        files: [],
        available: 0,
        mapped: 0,
        shadowedBy: null,
      },
    ]);
    expect(check?.verdict).toBe('empty');
    expect(verdictText(defined(check))).toBe('No project files in this mapping');
  });

  it('calls a result in between partly matching', async () => {
    const plan = planVerification(server(), files('src/', 20), 20, first);
    const present = new Set(plan[0]?.files.slice(0, 10).map((file) => file.remote));
    const [check] = await verifyMappings(target(present), plan);
    expect(check?.verdict).toBe('partial');
    expect(verdictText(defined(check))).toBe('10/20 files found – mapping matches only partly');
  });
});

describe('Verify Mapping outcomes that must not look like success', () => {
  it('tells a mapping whose files are all excluded from one without files', async () => {
    const plans = planVerification(
      server({
        mappings: [
          { localPath: 'vendor', deploymentPath: 'v' },
          { localPath: 'missing', deploymentPath: 'm' },
        ],
        excludedLocalPaths: ['vendor'],
      }),
      ['vendor/a.php', 'vendor/b.php'],
      20,
      first,
    );
    const checks = await verifyMappings({ stat: () => Promise.resolve(FILE) }, plans);
    expect(checks.map((check) => check.verdict)).toEqual(['excluded', 'empty']);
    expect(verdictText(defined(checks[0]))).toBe('All project files of this mapping are excluded');
    expect(overallPassed(checks)).toBe(false);
  });

  it('passes only when every mapping looks correct', async () => {
    const plans = planVerification(server(), files('src/', 20), 20, first);
    const ok = await verifyMappings({ stat: () => Promise.resolve(FILE) }, plans);
    expect(overallPassed(ok)).toBe(true);
    const none = await verifyMappings({ stat: () => Promise.resolve(null) }, plans);
    expect(overallPassed(none)).toBe(false);
    expect(overallPassed([])).toBe(false);
  });

  it('counts a file whose stat fails with an SFTP error as not checked, with its path', async () => {
    const plans = planVerification(server(), ['src/a.php', 'src/b.php', 'src/c.php'], 20, first);
    const denied = Object.assign(new Error('Permission denied'), { code: 3 });
    const checks = await verifyMappings(
      {
        stat: (path) => (path.endsWith('b.php') ? Promise.reject(denied) : Promise.resolve(FILE)),
      },
      plans,
    );
    const [check] = checks;
    expect(check).toMatchObject({ checked: 2, found: 2, verdict: 'correct' });
    expect(check?.unchecked).toEqual([{ local: 'src/b.php', reason: 'Permission denied' }]);
    expect(verdictText(defined(check))).toBe(
      '2/2 files found – mapping looks correct (1 could not be checked)',
    );
    expect(overallPassed(checks)).toBe(false);
  });

  it('calls a mapping where nothing could be checked unchecked', async () => {
    const plans = planVerification(server(), ['src/a.php'], 20, first);
    const denied = Object.assign(new Error('Permission denied'), { code: 3 });
    const [check] = await verifyMappings({ stat: () => Promise.reject(denied) }, plans);
    expect(check?.verdict).toBe('unchecked');
    expect(verdictText(defined(check))).toBe('None of the 1 files could be checked');
  });

  it('still fails on an error of the connection itself', async () => {
    const plans = planVerification(server(), ['src/a.php'], 20, first);
    await expect(
      verifyMappings({ stat: () => Promise.reject(new Error('channel closed')) }, plans),
    ).rejects.toThrow('channel closed');
  });

  it('says that a mapping is shadowed by an earlier one with the same local path', async () => {
    const plans = planVerification(
      server({
        mappings: [
          { localPath: 'src', deploymentPath: 'a' },
          { localPath: './src/', deploymentPath: 'b' },
        ],
      }),
      ['src/x.php'],
      20,
      first,
    );
    expect(plans[1]?.shadowedBy).toBe(0);
    const checks = await verifyMappings({ stat: () => Promise.resolve(FILE) }, plans);
    expect(checks[1]?.verdict).toBe('shadowed');
    expect(verdictText(defined(checks[1]))).toBe(
      'Mapping 1 has the same local path, so this mapping is never used',
    );
  });
});
