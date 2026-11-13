/**
 * Error messages about configuration files end up in notifications, so they never quote file
 * content: somebody may have pasted a password into the wrong place. Only positions, fixed
 * texts and property names that look like ordinary identifiers are shown.
 */

const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

/** A property name as it may appear in a message: verbatim only when it is a plain identifier. */
export function describeKey(key: string): string {
  return PLAIN_KEY.test(key) ? key : '(property with an unusual name)';
}

/** "not valid JSON (line 3, column 7)", or without the position when the parser gives none. */
export function describeJsonError(error: SyntaxError, text: string): string {
  const match = /\bposition (\d+)\b/.exec(error.message);
  if (match?.[1] === undefined) {
    return 'not valid JSON';
  }
  const position = Math.min(Number(match[1]), text.length);
  const before = text.slice(0, position).split('\n');
  const line = before.length;
  const column = (before.at(-1)?.length ?? 0) + 1;
  return `not valid JSON (line ${line}, column ${column})`;
}
