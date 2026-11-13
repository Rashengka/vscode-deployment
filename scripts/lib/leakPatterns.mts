/**
 * Generic patterns for content that must never be committed to this public repository:
 * absolute paths from a developer machine. They are deliberately generic, so the list itself
 * reveals nothing about anyone.
 *
 * The regular expressions are assembled from parts so that this file does not match itself.
 * Findings carry no matched text, so that reporting a leak in a public CI log does not repeat it.
 */

export interface LeakPattern {
  readonly id: string;
  readonly description: string;
  readonly regex: RegExp;
}

const USERS = 'Users';
const HOME = 'home';
const PRIVATE = 'private';
const FOLDERS = 'folders';

export const LEAK_PATTERNS: readonly LeakPattern[] = [
  {
    id: 'macos-home',
    description: 'macOS home directory path',
    regex: new RegExp(`/${USERS}/`),
  },
  {
    id: 'linux-home',
    description: 'Linux home directory path (only the placeholder deploy user is allowed)',
    regex: new RegExp(`/${HOME}/(?!deploy(?![\\w.-]))`),
  },
  {
    id: 'windows-home',
    description: 'Windows profile directory path',
    regex: new RegExp(`\\b[A-Za-z]:(?:\\\\{1,2}|/)${USERS}(?:\\\\{1,2}|/)`, 'i'),
  },
  {
    id: 'macos-private-tmp',
    description: 'macOS temporary directory path',
    regex: new RegExp(`/${PRIVATE}/tmp/`),
  },
  {
    id: 'macos-var-folders',
    description: 'macOS per-user temporary directory path',
    regex: new RegExp(`(?:/${PRIVATE})?/var/${FOLDERS}/`),
  },
  {
    id: 'home-path-slug',
    description: 'home directory path encoded as a directory name',
    regex: new RegExp(`-${USERS}-`),
  },
];

export interface LeakFinding {
  readonly file: string;
  readonly line: number;
  readonly patternId: string;
}

/** Ids of all patterns that match `text` (a line, a file name or a commit message). */
export function matchLeakPatterns(text: string): string[] {
  return LEAK_PATTERNS.filter((pattern) => pattern.regex.test(text)).map((pattern) => pattern.id);
}

export function findLeaks(file: string, content: string): LeakFinding[] {
  const findings: LeakFinding[] = [];
  content.split(/\r?\n/).forEach((text, index) => {
    for (const patternId of matchLeakPatterns(text)) {
      findings.push({ file, line: index + 1, patternId });
    }
  });
  return findings;
}
