/**
 * The `.vsix` may only contain the files listed in `package.json` `files` plus the metadata
 * that `vsce` always adds. Anything else (sources, tests, source maps, native addons, local
 * notes) is a packaging leak. The allowlist is exact on purpose: a new shipped file has to be
 * added here deliberately.
 */

/** Exact entries `vsce` generates or renames (`LICENSE` -> `LICENSE.txt`, lower-case docs). */
const METADATA_FILES: readonly string[] = [
  '[Content_Types].xml',
  'extension.vsixmanifest',
  'extension/package.json',
  'extension/readme.md',
  'extension/changelog.md',
  'extension/LICENSE.txt',
];

/** The bundle entry points produced by `scripts/build.mts`. */
const BUNDLE_FILES: readonly string[] = ['extension/dist/extension.js', 'extension/dist/ssh2.js'];

/** JSON schema of `config.json`, referenced by `contributes.jsonValidation`. */
const SCHEMA_FILES: readonly string[] = ['extension/schemas/config.schema.json'];

const ALLOWED_FILES: ReadonlySet<string> = new Set([
  ...METADATA_FILES,
  ...BUNDLE_FILES,
  ...SCHEMA_FILES,
]);

/** Entries that must be present, so that an empty or truncated listing is never accepted. */
export const REQUIRED_ENTRIES: readonly string[] = [
  'extension/package.json',
  ...BUNDLE_FILES,
  ...SCHEMA_FILES,
];

export interface VsixContentReport {
  readonly disallowed: readonly string[];
  readonly missing: readonly string[];
}

export function checkVsixEntries(entries: readonly string[]): VsixContentReport {
  const disallowed = entries.filter((entry) => !entry.endsWith('/') && !ALLOWED_FILES.has(entry));
  const present = new Set(entries);
  const missing = REQUIRED_ENTRIES.filter((entry) => !present.has(entry));
  return { disallowed, missing };
}
