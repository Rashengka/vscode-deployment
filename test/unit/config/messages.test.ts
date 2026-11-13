import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { describeJsonError, describeKey } from '../../../src/config/messages';

function parseError(text: string): SyntaxError {
  try {
    JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a syntax error');
}

describe('describeJsonError', () => {
  it.each([
    // A bare word, as when a password is pasted without quotes.
    (secret: string) => `{\n  "projectPath": "/var/www/app",\n  "x": ${secret}\n}`,
    (secret: string) => `{ "x": "${secret}"`,
    (secret: string) => `{ "x": "${secret}", }`,
    (secret: string) => secret,
    (secret: string) => `{ "${secret}" 1 }`,
  ])('never contains the input (%#)', (build) => {
    const secret = `pw${randomBytes(6).toString('hex')}`;
    const text = build(secret);
    const message = describeJsonError(parseError(text), text);
    expect(message).toMatch(/^not valid JSON( \(line \d+, column \d+\))?$/);
    expect(message).not.toContain(secret);
    expect(message).not.toContain(secret.slice(0, 4));
  });

  it('reports line and column when the parser gives a position', () => {
    const text = '{\n  "a": 1\n  "b": 2\n}';
    const error = new SyntaxError(
      "Expected ',' or '}' after property value in JSON at position 13",
    );
    expect(describeJsonError(error, text)).toBe('not valid JSON (line 3, column 3)');
  });
});

describe('describeKey', () => {
  it('shows plain identifiers and hides anything else', () => {
    expect(describeKey('password')).toBe('password');
    expect(describeKey('hunter2 is my password')).toBe('(property with an unusual name)');
    expect(describeKey('a'.repeat(41))).toBe('(property with an unusual name)');
    expect(describeKey('x\u0000')).toBe('(property with an unusual name)');
  });
});
