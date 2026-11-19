/**
 * Text that comes from a server (banners, file names, error messages) is untrusted. Before it
 * is shown anywhere (messages, QuickPick, the output channel) it goes through
 * {@link sanitizeForDisplay}, which makes every character that could change how the text is
 * displayed visible as an escape:
 *
 * - control characters (`\p{Cc}`: C0, DEL, C1 — terminal escape sequences, carriage returns
 *   that overwrite a line, NUL),
 * - format characters (`\p{Cf}`: bidirectional formatting, which can make `txt.exe` look like
 *   `exe.txt`, zero-width characters, tag characters, BOM, soft hyphen),
 * - line and paragraph separators (`\p{Zl}`, `\p{Zp}`),
 * - every other default-ignorable code point (variation selectors, Hangul fillers, …), which
 *   renders as nothing,
 * - lone surrogates (not valid text).
 *
 * The result is plain text; it is never interpreted as HTML or Markdown here. Notifications
 * need more (links): see `src/ui/notifications.ts`.
 */

export interface SanitizeOptions {
  /** Keep line feeds and tabs (CRLF becomes LF). Default: everything on one line. */
  readonly multiline?: boolean;
  /** Characters (code points) of the input to keep; the rest is summarized. Default 2000. */
  readonly maxLength?: number;
}

const DEFAULT_MAX_LENGTH = 2000;

/**
 * The characters {@link sanitizeForDisplay} escapes: control, format, line and paragraph
 * separators, every other default-ignorable code point, and (with the u flag, only those not
 * part of a pair) lone surrogates. Shared with the checks that refuse such characters in names
 * and paths from a server, so that what is refused and what is escaped never differ.
 */
const INVISIBLE_CLASS = '[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\p{Default_Ignorable_Code_Point}\\p{Cs}]';
const INVISIBLE_CHARACTER = new RegExp(`^${INVISIBLE_CLASS}$`, 'u');
const ANY_INVISIBLE = new RegExp(INVISIBLE_CLASS, 'u');

/** Whether `text` has a character that {@link sanitizeForDisplay} would escape (line breaks and tabs included). */
export function hasInvisibleCharacters(text: string): boolean {
  return ANY_INVISIBLE.test(text);
}

function escapeCharacter(character: string, multiline: boolean): string {
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
  if (!INVISIBLE_CHARACTER.test(character)) {
    return character;
  }
  const code = character.codePointAt(0) ?? 0;
  if (code <= 0xff) {
    return `\\x${code.toString(16).padStart(2, '0')}`;
  }
  return code <= 0xffff ? `\\u${code.toString(16).padStart(4, '0')}` : `\\u{${code.toString(16)}}`;
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
