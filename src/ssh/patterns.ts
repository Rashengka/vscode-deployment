/**
 * OpenSSH style host patterns, shared by the ssh_config resolver and the known_hosts parser.
 *
 * A pattern may contain `*` (any sequence, including an empty one) and `?` (exactly one
 * character). Matching is case-insensitive unless asked otherwise: OpenSSH lower-cases host
 * names for known_hosts and `IgnoreUnknown`, but matches `Host` lines case-sensitively.
 */

/**
 * Whether `text` matches the wildcard `pattern`. Runs in O(text × pattern) without regexes.
 * Case-insensitive unless `caseSensitive` is set (`Host` lines, file names in `Include` globs).
 */
export function matchWildcard(text: string, pattern: string, caseSensitive = false): boolean {
  const t = caseSensitive ? text : text.toLowerCase();
  const p = caseSensitive ? pattern : pattern.toLowerCase();
  let ti = 0;
  let pi = 0;
  let starPi = -1;
  let starTi = 0;
  while (ti < t.length) {
    const pc = p[pi];
    if (pc === '*') {
      starPi = pi;
      starTi = ti;
      pi += 1;
    } else if (pc !== undefined && (pc === '?' || pc === t[ti])) {
      pi += 1;
      ti += 1;
    } else if (starPi !== -1) {
      pi = starPi + 1;
      starTi += 1;
      ti = starTi;
    } else {
      return false;
    }
  }
  while (p[pi] === '*') {
    pi += 1;
  }
  return pi === p.length;
}

/** Whether a pattern contains a wildcard or a negation and so does not name one host. */
export function isWildcardOrNegatedPattern(pattern: string): boolean {
  return pattern.startsWith('!') || pattern.includes('*') || pattern.includes('?');
}

/**
 * Matches `text` against a list of patterns where a pattern prefixed with `!` negates.
 *
 * Returns `negated` if any negated pattern matches (this always wins), `matched` if a
 * positive pattern matches and `none` otherwise. A list made only of negations never matches.
 * An empty pattern matches only the empty string, as in OpenSSH.
 */
export function matchPatternList(
  text: string,
  patterns: readonly string[],
  caseSensitive = false,
): 'matched' | 'negated' | 'none' {
  let matched = false;
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      if (matchWildcard(text, pattern.slice(1), caseSensitive)) {
        return 'negated';
      }
    } else if (matchWildcard(text, pattern, caseSensitive)) {
      matched = true;
    }
  }
  return matched ? 'matched' : 'none';
}
