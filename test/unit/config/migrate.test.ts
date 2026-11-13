import { describe, expect, it } from 'vitest';
import { CONFIG_MIGRATIONS, migrateConfig, type MigrationStep } from '../../../src/config/migrate';
import { CONFIG_VERSION } from '../../../src/config/model';

describe('migrateConfig', () => {
  it('has a step for every version below the current one', () => {
    for (let version = 1; version < CONFIG_VERSION; version++) {
      expect(CONFIG_MIGRATIONS[version], `migration from ${version}`).toBeTypeOf('function');
    }
  });

  it('leaves a current configuration unchanged', () => {
    const value = { version: CONFIG_VERSION, projectPath: '/var/www/app', servers: [] };
    expect(migrateConfig(value)).toEqual({ ok: true, value, migratedFrom: null });
  });

  it('refuses a version newer than this build understands', () => {
    const result = migrateConfig({ version: CONFIG_VERSION + 1 });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: expect.stringContaining('newer version') as unknown });
  });

  it('passes values without a usable version to the validator unchanged', () => {
    for (const value of [null, [], 'x', {}, { version: '1' }, { version: 0 }, { version: 1.5 }]) {
      expect(migrateConfig(value)).toEqual({ ok: true, value, migratedFrom: null });
    }
  });

  it('runs every step in order and sets the version after each', () => {
    const seen: number[] = [];
    const steps: Record<number, MigrationStep> = {
      1: (config) => {
        seen.push(config['version'] as number);
        return { ...config, servers: config['hosts'], hosts: undefined };
      },
      2: (config) => {
        seen.push(config['version'] as number);
        return { version: config['version'], servers: config['servers'], renamed: true };
      },
    };
    const result = migrateConfig({ version: 1, hosts: ['a'] }, steps, 3);
    expect(seen).toEqual([1, 2]);
    expect(result).toEqual({
      ok: true,
      value: { version: 3, servers: ['a'], renamed: true },
      migratedFrom: 1,
    });
  });

  it('fails when a step is missing instead of skipping it', () => {
    expect(migrateConfig({ version: 1 }, {}, 2)).toEqual({
      ok: false,
      error: 'no migration from version 1',
    });
  });
});
