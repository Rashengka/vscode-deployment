/**
 * Text for VS Code notifications (`showInformationMessage`, `showErrorMessage`, …).
 *
 * Notifications render Markdown links, `[label](target)`, as clickable links, including
 * `command:` links that run any VS Code command with arguments. Text from the server (a home
 * directory, an error or disconnect message, which a man-in-the-middle can send even before the
 * host key is checked) must never become one. {@link notificationText} therefore
 * - removes anything that looks like private key material (`redactKeyMaterial`),
 * - makes invisible and control characters visible (`sanitizeForDisplay`),
 * - breaks every `](` with a space, so that no link syntax is left,
 * - and shortens the text; the full text goes to the Deployment log only.
 */
import { sanitizeForDisplay } from '../display/sanitize';
import { redactKeyMaterial } from '../log/deploymentLog';

export function notificationText(text: string, maxLength = 300): string {
  return sanitizeForDisplay(redactKeyMaterial(text), { maxLength }).replace(/\]\(/g, '] (');
}
