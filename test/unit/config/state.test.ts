import { describe, expect, it } from 'vitest';
import { emptyState, type DeploymentState } from '../../../src/config/model';
import { mergeState, validateState } from '../../../src/config/state';

const PROJECT = '/var/www/app';
const RECORD = { mtime: 1_700_000_000, size: 42, uploadedAt: 1_700_000_000_123 };

describe('validateState', () => {
  it('accepts an empty and a filled state', () => {
    expect(validateState(emptyState(PROJECT))).toEqual({ ok: true, state: emptyState(PROJECT) });
    const filled = {
      version: 1,
      projectPath: PROJECT,
      servers: { a: { 'www/index.php': RECORD } },
    };
    expect(validateState(filled)).toEqual({ ok: true, state: filled });
  });

  it('rejects unknown properties, a wrong version and broken records', () => {
    expect(validateState(null)).toEqual({ ok: false, errors: ['state: must be an object'] });
    const result = validateState({
      version: 2,
      extra: true,
      'secret value': 1,
      servers: { a: { 'hunter2/x': { mtime: 1, size: -1, uploadedAt: 1 } }, b: [] },
    });
    expect(result).toEqual({
      ok: false,
      errors: [
        'state.extra: unknown property',
        'state.(property with an unusual name): unknown property',
        'state.version: must be 1',
        'state.projectPath: must be a non-empty string',
        'state.servers (server 1, entry 1): must have numeric mtime, size and uploadedAt',
        'state.servers (server 2): must be an object',
      ],
    });
    // Messages name entries by position and never quote keys taken from the file.
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });
});

describe('mergeState', () => {
  it('keeps entries written by another window and applies only the updates', () => {
    // What another window wrote to disk after this window last read the file.
    const onDisk: DeploymentState = {
      version: 1,
      projectPath: PROJECT,
      servers: {
        a: { 'www/other.php': RECORD },
        b: { 'index.php': RECORD },
      },
    };
    const merged = mergeState(onDisk, [
      { serverId: 'a', remotePath: 'www/index.php', record: { ...RECORD, size: 7 } },
    ]);
    expect(JSON.parse(JSON.stringify(merged))).toEqual({
      version: 1,
      projectPath: PROJECT,
      servers: {
        a: { 'www/other.php': RECORD, 'www/index.php': { ...RECORD, size: 7 } },
        b: { 'index.php': RECORD },
      },
    });
  });

  it('removes forgotten paths and empty servers without mutating the input', () => {
    const base: DeploymentState = {
      version: 1,
      projectPath: PROJECT,
      servers: { a: { x: RECORD } },
    };
    const merged = mergeState(base, [{ serverId: 'a', remotePath: 'x', record: null }]);
    expect(Object.keys(merged.servers)).toEqual([]);
    expect(base.servers['a']).toEqual({ x: RECORD });
  });

  it('treats "__proto__" as an ordinary key', () => {
    const merged = mergeState(emptyState(PROJECT), [
      { serverId: '__proto__', remotePath: '__proto__', record: RECORD },
    ]);
    expect(({} as Record<string, unknown>)['mtime']).toBeUndefined();
    expect(JSON.parse(JSON.stringify(merged))).toEqual(
      JSON.parse(
        '{"version":1,"projectPath":"/var/www/app","servers":{"__proto__":{"__proto__":{"mtime":1700000000,"size":42,"uploadedAt":1700000000123}}}}',
      ),
    );
  });
});
