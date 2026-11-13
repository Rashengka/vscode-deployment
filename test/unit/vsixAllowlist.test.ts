import { describe, expect, it } from 'vitest';
import { REQUIRED_ENTRIES, checkVsixEntries } from '../../scripts/lib/vsixAllowlist.mts';

const VALID_PACKAGE = [
  '[Content_Types].xml',
  'extension.vsixmanifest',
  'extension/',
  'extension/package.json',
  'extension/readme.md',
  'extension/changelog.md',
  'extension/LICENSE.txt',
  'extension/dist/',
  'extension/dist/extension.js',
  'extension/dist/ssh2.js',
  'extension/dist/kdfWorker.js',
  'extension/schemas/',
  'extension/schemas/config.schema.json',
];

describe('checkVsixEntries', () => {
  it('accepts a package with only allowlisted files', () => {
    expect(checkVsixEntries(VALID_PACKAGE)).toEqual({ disallowed: [], missing: [] });
  });

  it.each([
    'extension/src/extension.ts',
    'extension/node_modules/ssh2/lib/index.js',
    'extension/notes/todo.md',
    'extension/.env',
    'extension/.vscode/settings.json',
    'extension/.idea/workspace.xml',
    'extension/test/unit/sample.test.ts',
    'extension/package-lock.json',
    'extension/dist/../src/extension.ts',
    'extension/build/Release/sshcrypto.node',
    'extension/dist/extension.js.map',
    'extension/dist/ssh2.js.map',
    'extension/dist/sshcrypto.node',
    'extension/dist/other.js',
    'extension/schemas/state.schema.json',
    'extension/schemas/config.schema.json.bak',
  ])('rejects %s', (entry) => {
    expect(checkVsixEntries([...VALID_PACKAGE, entry]).disallowed).toEqual([entry]);
  });

  it('reports required files that are missing', () => {
    expect(checkVsixEntries([]).missing).toEqual(REQUIRED_ENTRIES);
    const withoutSsh2 = VALID_PACKAGE.filter((entry) => entry !== 'extension/dist/ssh2.js');
    expect(checkVsixEntries(withoutSsh2).missing).toEqual(['extension/dist/ssh2.js']);
    const withoutSchema = VALID_PACKAGE.filter(
      (entry) => entry !== 'extension/schemas/config.schema.json',
    );
    expect(checkVsixEntries(withoutSchema).missing).toEqual([
      'extension/schemas/config.schema.json',
    ]);
  });
});
