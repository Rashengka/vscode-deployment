/**
 * The modal question after a settings panel with unsaved changes was closed.
 *
 * VS Code makes the first item the default button (the one Enter chooses) and an item with
 * `isCloseAffordance` the button for Escape; without one it adds its own Cancel. So the safe
 * choice comes first and no item is a close affordance: Enter, Escape, Cancel and closing the
 * dialog all keep the changes, and only Discard drops them.
 */
import { sanitizeForDisplay } from '../display/sanitize';

export interface PromptItem {
  readonly title: string;
  readonly isCloseAffordance?: boolean;
}

export interface DiscardPrompt {
  readonly message: string;
  readonly options: { readonly modal: true; readonly detail: string };
  readonly items: readonly [keep: PromptItem, discard: PromptItem];
}

export function discardPrompt(folderName: string): DiscardPrompt {
  const name = sanitizeForDisplay(folderName, { maxLength: 80 });
  return {
    message: `Discard the unsaved deployment settings of "${name}"?`,
    options: {
      modal: true,
      detail: 'Keep Editing (or Cancel) opens the settings again with your changes.',
    },
    items: [{ title: 'Keep Editing' }, { title: 'Discard' }],
  };
}

/** True only for the Discard item of this prompt; anything else keeps the changes. */
export function discardsChanges(prompt: DiscardPrompt, answer: PromptItem | undefined): boolean {
  return answer !== undefined && answer === prompt.items[1];
}
