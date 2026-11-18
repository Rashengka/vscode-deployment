import { describe, expect, it } from 'vitest';
import { notificationText } from '../../../src/ui/notifications';

const LINK = '[x](command:workbench.action.terminal.sendSequence?%7B%7D)';

describe('notificationText', () => {
  it('never leaves Markdown link syntax that a notification would turn into a link', () => {
    const text = notificationText(`home ${LINK} and [y]( command:x) [z](https://example.com)`);

    expect(text).not.toMatch(/\]\(/);
    expect(text).toContain('command:workbench.action.terminal.sendSequence');
  });

  it('removes key material, escapes invisible characters and shortens long text', () => {
    expect(notificationText('a\u001bb\u202ec')).toBe('a\\x1bb\\u202ec');
    expect(notificationText('x'.repeat(20), 5)).toBe('xxxxx… (15 more characters)');
  });
});
