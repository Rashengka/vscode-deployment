/**
 * Verify Mapping: checks that a server's mappings point at the right place by looking up a
 * random sample of project files on the server. Nothing is read or written there; every check
 * is a `stat`.
 *
 * Each mapping is sampled on its own, from the project files that belong to it (by the longest
 * local path) and are not excluded locally or on the server.
 */
import type { SftpServer } from '../config/model';
import type { DeploymentTarget } from '../transport/deploymentTarget';
import { isExcluded, mappingFor, pathSegments, remotePathOf } from './paths';

/** SFTP status errors carry the server's numeric status code. */
function isSftpStatusError(error: unknown): error is Error {
  return error instanceof Error && typeof (error as Error & { code?: unknown }).code === 'number';
}

export const VERIFY_SAMPLE_SIZE = 20;
/** At least this share found: the mapping looks correct. */
const LOOKS_CORRECT = 0.8;
/** At most this share found: the mapping is probably wrong. */
const PROBABLY_WRONG = 0.2;

/** A whole number from 0 to `max - 1`. */
export type RandomIndex = (max: number) => number;

export interface PlannedFile {
  /** Relative to the project folder. */
  readonly local: string;
  /** Absolute on the server. */
  readonly remote: string;
}

export interface MappingPlan {
  readonly mappingIndex: number;
  readonly localPath: string;
  readonly deploymentPath: string;
  readonly files: readonly PlannedFile[];
  /** How many project files the sample was drawn from. */
  readonly available: number;
  /** How many project files belong to the mapping, excluded ones included. */
  readonly mapped: number;
  /** An earlier mapping with the same local path, which gets all its files. */
  readonly shadowedBy: number | null;
}

export type Verdict =
  | 'correct'
  | 'partial'
  | 'wrong'
  /** No project file belongs to the mapping. */
  | 'empty'
  /** Every project file of the mapping is excluded. */
  | 'excluded'
  /** An earlier mapping has the same local path. */
  | 'shadowed'
  /** Not one sampled file could be looked up. */
  | 'unchecked';

export interface UncheckedFile {
  readonly local: string;
  /** The server's error message (untrusted; sanitize before showing it). */
  readonly reason: string;
}

export interface MappingCheck {
  readonly mappingIndex: number;
  readonly localPath: string;
  readonly deploymentPath: string;
  /** Sampled files the server answered for (found or not). */
  readonly checked: number;
  readonly found: number;
  /** Local paths of the sampled files that were not found. */
  readonly missing: readonly string[];
  /** Sampled files the server refused to look up (for example permission denied). */
  readonly unchecked: readonly UncheckedFile[];
  readonly verdict: Verdict;
  readonly shadowedBy: number | null;
}

/** `n` different items of `items`, chosen with `random` (a partial Fisher–Yates shuffle). */
export function sampleOf<T>(items: readonly T[], n: number, random: RandomIndex): T[] {
  const pool = [...items];
  const count = Math.min(n, pool.length);
  for (let i = 0; i < count; i++) {
    const j = i + random(pool.length - i);
    const picked = pool[j] as T;
    pool[j] = pool[i] as T;
    pool[i] = picked;
  }
  return pool.slice(0, count);
}

/** The files to look up for every mapping of `server`, in the order of the mappings. */
export function planVerification(
  server: SftpServer,
  projectFiles: readonly string[],
  sampleSize: number,
  random: RandomIndex,
): MappingPlan[] {
  const groups: PlannedFile[][] = server.mappings.map(() => []);
  const mapped: number[] = server.mappings.map(() => 0);
  for (const local of projectFiles) {
    const match = mappingFor(server.mappings, local);
    if (match === undefined) {
      continue;
    }
    mapped[match.index] = (mapped[match.index] ?? 0) + 1;
    if (isExcluded(local, server.excludedLocalPaths)) {
      continue;
    }
    const belowRoot = [...pathSegments(match.mapping.deploymentPath), ...match.rest].join('/');
    if (isExcluded(belowRoot, server.excludedRemotePaths)) {
      continue;
    }
    groups[match.index]?.push({
      local,
      remote: remotePathOf(server.rootPath, match.mapping.deploymentPath, match.rest),
    });
  }
  const localKeys = server.mappings.map((mapping) => pathSegments(mapping.localPath).join('/'));
  return server.mappings.map((mapping, index) => {
    const group = groups[index] ?? [];
    const earlier = localKeys.indexOf(localKeys[index] ?? '');
    return {
      mappingIndex: index,
      localPath: mapping.localPath,
      deploymentPath: mapping.deploymentPath,
      files: sampleOf(group, sampleSize, random),
      available: group.length,
      mapped: mapped[index] ?? 0,
      shadowedBy: earlier < index ? earlier : null,
    };
  });
}

function verdictOf(plan: MappingPlan, found: number, checked: number): Verdict {
  if (plan.shadowedBy !== null) {
    return 'shadowed';
  }
  if (plan.files.length === 0) {
    return plan.mapped > 0 ? 'excluded' : 'empty';
  }
  if (checked === 0) {
    return 'unchecked';
  }
  const share = found / checked;
  if (share >= LOOKS_CORRECT) {
    return 'correct';
  }
  return share <= PROBABLY_WRONG ? 'wrong' : 'partial';
}

/**
 * Looks up the planned files, one after another. A file the server refuses to look up (an SFTP
 * status error such as permission denied) is reported as not checked; any other error (the
 * connection) ends the whole check.
 */
export async function verifyMappings(
  target: Pick<DeploymentTarget, 'stat'>,
  plans: readonly MappingPlan[],
): Promise<MappingCheck[]> {
  const checks: MappingCheck[] = [];
  for (const plan of plans) {
    const missing: string[] = [];
    const unchecked: UncheckedFile[] = [];
    let found = 0;
    for (const file of plan.files) {
      let stat: Awaited<ReturnType<DeploymentTarget['stat']>>;
      try {
        stat = await target.stat(file.remote);
      } catch (error) {
        if (!isSftpStatusError(error)) {
          throw error;
        }
        unchecked.push({ local: file.local, reason: error.message });
        continue;
      }
      if (stat === null || stat.type === 'directory') {
        missing.push(file.local);
      } else {
        found += 1;
      }
    }
    const checked = found + missing.length;
    checks.push({
      mappingIndex: plan.mappingIndex,
      localPath: plan.localPath,
      deploymentPath: plan.deploymentPath,
      checked,
      found,
      missing,
      unchecked,
      verdict: verdictOf(plan, found, checked),
      shadowedBy: plan.shadowedBy,
    });
  }
  return checks;
}

/** Whether the mappings look right: every used mapping looks correct, and one at least. */
export function overallPassed(
  checks: readonly Pick<MappingCheck, 'verdict' | 'unchecked'>[],
): boolean {
  const used = checks.filter((check) => check.verdict !== 'shadowed');
  return (
    used.length > 0 &&
    used.every((check) => check.verdict === 'correct' && check.unchecked.length === 0)
  );
}

const VERDICTS: Readonly<Record<'correct' | 'partial' | 'wrong', string>> = {
  correct: 'mapping looks correct',
  partial: 'mapping matches only partly',
  wrong: 'mapping is probably wrong',
};

export function verdictText(
  check: Pick<MappingCheck, 'checked' | 'found' | 'verdict' | 'unchecked' | 'shadowedBy'>,
): string {
  switch (check.verdict) {
    case 'empty':
      return 'No project files in this mapping';
    case 'excluded':
      return 'All project files of this mapping are excluded';
    case 'shadowed':
      return `Mapping ${(check.shadowedBy ?? 0) + 1} has the same local path, so this mapping is never used`;
    case 'unchecked':
      return `None of the ${check.unchecked.length} files could be checked`;
    default: {
      const unchecked =
        check.unchecked.length === 0 ? '' : ` (${check.unchecked.length} could not be checked)`;
      return `${check.found}/${check.checked} files found – ${VERDICTS[check.verdict]}${unchecked}`;
    }
  }
}
