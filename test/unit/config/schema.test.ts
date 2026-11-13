import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONFIG_KEYS,
  CONNECTION_KEYS,
  INPLACE_SERVER_KEYS,
  MAPPING_KEYS,
  SFTP_SERVER_KEYS,
  validateConfig,
} from '../../../src/config/validate';
import { PROJECT, json, sftpServer } from './fixtures';

interface SchemaNode {
  type?: string | string[];
  properties?: Record<string, SchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
  oneOf?: SchemaNode[];
  items?: SchemaNode;
  definitions?: Record<string, SchemaNode>;
  pattern?: string;
  $ref?: string;
}

const schema = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '..', '..', '..', 'schemas', 'config.schema.json'),
    'utf8',
  ),
) as SchemaNode;

function definition(name: string): SchemaNode {
  const node = schema.definitions?.[name];
  if (node === undefined) {
    throw new Error(`definition ${name} is missing`);
  }
  return node;
}

function resolve(node: SchemaNode): SchemaNode {
  return node.$ref === undefined ? node : definition(node.$ref.replace('#/definitions/', ''));
}

function* walk(node: SchemaNode, where: string): Generator<[string, SchemaNode]> {
  yield [where, node];
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    yield* walk(child, `${where}.${key}`);
  }
  for (const [key, child] of Object.entries(node.definitions ?? {})) {
    yield* walk(child, `${where}#${key}`);
  }
  if (node.items !== undefined) {
    yield* walk(node.items, `${where}[]`);
  }
  // Branches of a closed object only narrow its properties; they need no list of their own.
  if (node.additionalProperties !== false) {
    for (const [index, child] of (node.oneOf ?? []).entries()) {
      yield* walk(child, `${where}|${index}`);
    }
  }
}

function keysAndRequired(node: SchemaNode): [string[], string[]] {
  return [Object.keys(node.properties ?? {}).sort(), [...(node.required ?? [])].sort()];
}

describe('config.schema.json', () => {
  it('forbids unknown properties on every object', () => {
    const objects = [...walk(schema, 'config')].filter(([, node]) => node.properties);
    expect(objects.length).toBeGreaterThan(5);
    for (const [where, node] of objects) {
      const closed =
        node.additionalProperties === false ||
        (node.oneOf ?? []).every((branch) => resolve(branch).additionalProperties === false);
      expect(closed, where).toBe(true);
    }
  });

  it.each([
    ['the root', schema, CONFIG_KEYS],
    ['an SFTP server', definition('sftpServer'), SFTP_SERVER_KEYS],
    ['an in-place server', definition('inplaceServer'), INPLACE_SERVER_KEYS],
    ['a connection', definition('sftpServer').properties?.['connection'] ?? {}, CONNECTION_KEYS],
    ['a mapping', definition('sftpServer').properties?.['mappings']?.items ?? {}, MAPPING_KEYS],
  ])('lists exactly the properties the validator accepts for %s, all required', (_, node, keys) => {
    const expected = [...keys].sort();
    expect(keysAndRequired(node)).toEqual([expected, expected]);
  });

  it('requires exactly one of sshConfigHost and host', () => {
    const connection = definition('sftpServer').properties?.['connection'];
    const branches = (connection?.oneOf ?? []).map((branch) =>
      Object.fromEntries(
        Object.entries(branch.properties ?? {}).map(([key, value]) => [key, value.type]),
      ),
    );
    expect(branches).toEqual([
      { sshConfigHost: 'string', host: 'null' },
      { sshConfigHost: 'null', host: 'string' },
    ]);
  });

  it('applies the control character rule to ids and names, and forbids ":" in user', () => {
    const control = new RegExp(definition('id').pattern ?? '', 'u');
    expect(definition('name').pattern).toBe(definition('id').pattern);
    expect(control.test('a1b2c3')).toBe(true);
    expect(control.test('a\u0000')).toBe(false);
    const user = new RegExp(
      definition('sftpServer').properties?.['connection']?.properties?.['user']?.pattern ?? '',
      'u',
    );
    expect(user.test('deploy')).toBe(true);
    expect(user.test('deploy:x')).toBe(false);
  });

  it('has no property that could hold a secret', () => {
    const names = [...walk(schema, 'config')].flatMap(([, node]) =>
      Object.keys(node.properties ?? {}),
    );
    expect(names.length).toBeGreaterThan(20);
    expect(names.filter((name) => /pass|secret|token|credential|privatekey/i.test(name))).toEqual(
      [],
    );
  });

  describe('path patterns agree with the validator', () => {
    const relative = new RegExp(definition('relativePath').pattern ?? '', 'u');
    const rootPattern = definition('sftpServer').properties?.['rootPath']?.pattern;
    const root = new RegExp(rootPattern ?? '', 'u');

    it.each([
      '',
      '.',
      'www',
      'www/app.example.com',
      'a..b',
      'www/..app',
      '..',
      'www/..',
      'www/../x',
      '/www',
      'C:/www',
      'www\\x',
      'www\u0000',
      'www\u0085',
    ])('deploymentPath %j', (deploymentPath) => {
      const server = { ...json(sftpServer()), mappings: [{ localPath: '.', deploymentPath }] };
      const valid = validateConfig(
        { version: 1, projectPath: PROJECT, servers: [server] },
        { platform: 'linux' },
      ).ok;
      expect(relative.test(deploymentPath)).toBe(valid);
    });

    it.each(['/home/deploy', '/', '/a..b', 'home', '/var/../x', '/home\\x', '/x\u0007'])(
      'rootPath %j',
      (rootPath) => {
        const server = { ...json(sftpServer()), rootPath };
        const valid = validateConfig(
          { version: 1, projectPath: PROJECT, servers: [server] },
          { platform: 'linux' },
        ).ok;
        expect(root.test(rootPath)).toBe(valid);
      },
    );
  });
});
