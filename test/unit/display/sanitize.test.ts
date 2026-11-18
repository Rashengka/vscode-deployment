import { describe, expect, it } from 'vitest';
import { sanitizeForDisplay } from '../../../src/display/sanitize';

describe('sanitizeForDisplay', () => {
  it('keeps ordinary text, including non-Latin letters and emoji', () => {
    expect(sanitizeForDisplay('Welcome to app.example.com — žluťoučký kůň 🐎')).toBe(
      'Welcome to app.example.com — žluťoučký kůň 🐎',
    );
  });

  it('shows C0 control characters and DEL as escapes', () => {
    expect(sanitizeForDisplay('a\u0000b\u0007c\u001b[31md\u007f')).toBe(
      'a\\x00b\\x07c\\x1b[31md\\x7f',
    );
  });

  it('shows C1 control characters as escapes', () => {
    expect(sanitizeForDisplay('a\u0085b\u009bc')).toBe('a\\x85b\\x9bc');
  });

  it('shows bidirectional formatting and invisible characters as escapes', () => {
    expect(
      sanitizeForDisplay(
        'x\u202ey\u2066z\u2069\u200b\u200e\u200f\u061c\u2028\u2029\ufeff\u00ad\u180e\u2060',
      ),
    ).toBe(
      'x\\u202ey\\u2066z\\u2069\\u200b\\u200e\\u200f\\u061c\\u2028\\u2029\\ufeff\\xad\\u180e\\u2060',
    );
  });

  it('shows tag characters, variation selectors and other ignorable characters as escapes', () => {
    expect(sanitizeForDisplay('a\u{e0041}b\u{e0001}\u{e007f}')).toBe(
      'a\\u{e0041}b\\u{e0001}\\u{e007f}',
    );
    expect(sanitizeForDisplay('aㅤbﾠcᅟᅠ')).toBe('a\\u3164b\\uffa0c\\u115f\\u1160');
    expect(sanitizeForDisplay('x️y͏z឴឵\u{e0100}')).toBe('x\\ufe0fy\\u034fz\\u17b4\\u17b5\\u{e0100}');
  });

  it('replaces lone surrogates', () => {
    expect(sanitizeForDisplay('a\ud800b\udc00c')).toBe('a\\ud800b\\udc00c');
  });

  it('turns line breaks and tabs into escapes on a single line', () => {
    expect(sanitizeForDisplay('one\r\ntwo\tthree\n')).toBe('one\\r\\ntwo\\tthree\\n');
  });

  it('keeps line breaks and tabs of multi-line text and normalizes CRLF', () => {
    expect(sanitizeForDisplay('one\r\ntwo\tthree\rfour', { multiline: true })).toBe(
      'one\ntwo\tthree\\rfour',
    );
  });

  it('cuts long text', () => {
    const result = sanitizeForDisplay('x'.repeat(50), { maxLength: 10 });

    expect(result).toBe('xxxxxxxxxx… (40 more characters)');
  });

  it('never cuts an escape or a surrogate pair in half', () => {
    expect(sanitizeForDisplay('ab\u001bcd', { maxLength: 3 })).toBe('ab\\x1b… (2 more characters)');
    expect(sanitizeForDisplay('a🐎b', { maxLength: 2 })).toBe('a🐎… (1 more characters)');
  });

  it('is idempotent', () => {
    const once = sanitizeForDisplay('a\u001bb\u202ec');

    expect(sanitizeForDisplay(once)).toBe(once);
  });
});
