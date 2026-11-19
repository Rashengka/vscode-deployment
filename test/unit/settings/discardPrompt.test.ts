import { describe, expect, it } from 'vitest';
import { discardPrompt, discardsChanges } from '../../../src/settings/discardPrompt';

describe('the prompt after closing the settings with unsaved changes', () => {
  it('offers Keep Editing first, so that it is the default button, and Discard second', () => {
    const prompt = discardPrompt('app');
    expect(prompt.items.map((item) => item.title)).toEqual(['Keep Editing', 'Discard']);
    expect(prompt.options.modal).toBe(true);
  });

  it('leaves the close button (Escape) to VS Code, which then keeps the changes', () => {
    // An item with isCloseAffordance would replace VS Code's Cancel; none may, so that neither
    // Escape nor closing the dialog can discard.
    expect(discardPrompt('app').items.some((item) => item.isCloseAffordance === true)).toBe(false);
    expect(discardsChanges(discardPrompt('app'), undefined)).toBe(false);
  });

  it('discards only when Discard itself is chosen', () => {
    const prompt = discardPrompt('app');
    const [keep, discard] = prompt.items;
    expect(discardsChanges(prompt, discard)).toBe(true);
    expect(discardsChanges(prompt, keep)).toBe(false);
    // An item of another prompt with the same title is not this prompt's answer.
    expect(discardsChanges(prompt, { title: 'Discard' })).toBe(false);
  });

  it('shows the folder name as plain text, shortened', () => {
    const prompt = discardPrompt(`a‮b${'x'.repeat(200)}`);
    expect(prompt.message).not.toContain('‮');
    expect(prompt.message.length).toBeLessThan(160);
    expect(prompt.options.detail).toMatch(/Keep Editing/);
  });
});
