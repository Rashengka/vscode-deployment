/**
 * Migration of `config.json` from older versions. Each step turns version `n` into `n + 1`;
 * the result is validated afterwards, so a step only has to reshape the data. Version 1 is the
 * first version, so there are no steps yet.
 */
import { CONFIG_VERSION } from './model';

export type MigrationStep = (config: Record<string, unknown>) => Record<string, unknown>;

/** Steps keyed by the version they migrate from. */
export const CONFIG_MIGRATIONS: Readonly<Record<number, MigrationStep>> = {};

export type MigrationResult =
  | { readonly ok: true; readonly value: unknown; readonly migratedFrom: number | null }
  | { readonly ok: false; readonly error: string };

/**
 * Brings `value` to `targetVersion`. Values without a usable `version` are returned unchanged
 * for the validator to report; a version newer than this build understands is an error, so that
 * an older build never rewrites a file it does not understand.
 */
export function migrateConfig(
  value: unknown,
  migrations: Readonly<Record<number, MigrationStep>> = CONFIG_MIGRATIONS,
  targetVersion: number = CONFIG_VERSION,
): MigrationResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: true, value, migratedFrom: null };
  }
  let current = value as Record<string, unknown>;
  const startVersion = current['version'];
  if (typeof startVersion !== 'number' || !Number.isInteger(startVersion) || startVersion < 1) {
    return { ok: true, value, migratedFrom: null };
  }
  if (startVersion > targetVersion) {
    return {
      ok: false,
      error: `version ${startVersion} was written by a newer version of the extension (this one supports up to ${targetVersion})`,
    };
  }
  for (let version = startVersion; version < targetVersion; version++) {
    const step = migrations[version];
    if (step === undefined) {
      return { ok: false, error: `no migration from version ${version}` };
    }
    current = { ...step(current), version: version + 1 };
  }
  return {
    ok: true,
    value: current,
    migratedFrom: startVersion === targetVersion ? null : startVersion,
  };
}
