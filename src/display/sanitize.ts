/**
 * Text that comes from a server (banners, file names, error messages) is untrusted. Before it
 * is shown anywhere (messages, QuickPick, the output channel) it goes through
 * {@link sanitizeForDisplay}, which makes every character that could change how the text is
 * displayed visible as an escape:
 *
 * - C0 control characters and DEL (terminal escape sequences, carriage returns that overwrite
 *   a line, NUL),
 * - C1 control characters,
 * - bidirectional formatting characters (which can make `txt.exe` look like `exe.txt`) and
 *   invisible characters (zero-width spaces and joiners, line and paragraph separators, BOM,
 *   soft hyphen),
 * - lone surrogates (not valid text).
 *
 * The result is plain text; it is never interpreted as HTML or Markdown here.
 */

export interface SanitizeOptions {
  /** Keep line feeds and tabs (CRLF becomes LF). Default: everything on one line. */
  readonly multiline?: boolean;
  /** Characters (code points) of the input to keep; the rest is summarized. Default 2000. */
  readonly maxLength?: number;
}

const DEFAULT_MAX_LENGTH = 2000;

// eslint-disable-next-line no-control-regex -- finding control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const FORMATTING =
  /[\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]/;
// With the u flag, only surrogates that are not part of a pair match.
const LONE_SURROGATE = /[\ud800-\udfff]/u;

function hex(code: number, width: number): string {
  return code.toString(16).padStart(width, '0');
}

function escapeCharacter(character: string, multiline: boolean): string {
  const code = character.codePointAt(0) ?? 0;
  if (multiline && (character === '\n' || character === '\t')) {
    return character;
  }
  switch (character) {
    case '\n':
      return '\\n';
    case '\r':
      return '\\r';
    case '\t':
      return '\\t';
    default:
  }
  if (CONTROL.test(character)) {
    return `\\x${hex(code, 2)}`;
  }
  if (FORMATTING.test(character) || LONE_SURROGATE.test(character)) {
    return `\\u${hex(code, 4)}`;
  }
  return character;
}

export function sanitizeForDisplay(text: string, options: SanitizeOptions = {}): string {
  const multiline = options.multiline ?? false;
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  // Code points on purpose: every character is judged on its own, also inside a grapheme
  // cluster, and a lone surrogate comes out on its own.
  // eslint-disable-next-line @typescript-eslint/no-misused-spread
  const characters = [...(multiline ? text.replace(/\r\n/g, '\n') : text)];
  const kept = characters.slice(0, maxLength);
  const escaped = kept.map((character) => escapeCharacter(character, multiline)).join('');
  const rest = characters.length - kept.length;
  return rest > 0 ? `${escaped}… (${rest} more characters)` : escaped;
}

/** Sanitizes the message of an error for display; anything that is not an Error is not shown. */
export function describeErrorForDisplay(error: unknown): string {
  return error instanceof Error ? sanitizeForDisplay(error.message) : 'Unknown error.';
}
