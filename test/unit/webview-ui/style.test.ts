import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../../src/webview-ui/style.css', import.meta.url), 'utf8');

/** The declarations of the rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  if (start === -1) {
    throw new Error(`No rule for ${selector}`);
  }
  return css.slice(start, css.indexOf('}', start));
}

describe('settings view style', () => {
  it('rounds buttons, inputs and dropdowns like VS Code does', () => {
    expect(rule(':root')).toContain('--corner-radius: var(--vscode-cornerRadius-small, 4px);');
    expect(rule('button')).toContain('border-radius: var(--corner-radius);');
    expect(rule("input[type='text'],\nselect")).toContain('border-radius: var(--corner-radius);');
  });

  it('keeps the tabs square, so that their underline stays straight', () => {
    expect(rule('button.tab')).toContain('border-radius: 0;');
  });
});
