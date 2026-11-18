/**
 * The HTML document of the settings webview: an empty page that loads one bundled script and
 * one stylesheet from the extension. The Content Security Policy allows nothing else — no
 * inline script or style, no remote resource, no `<base>` and no form submission — and the
 * script runs only with the nonce of this document.
 */
import { randomBytes } from 'node:crypto';

export interface SettingsHtmlInput {
  /** `webview.cspSource`. */
  readonly cspSource: string;
  /** Webview URIs of the bundled script and stylesheet. */
  readonly scriptUri: string;
  readonly styleUri: string;
  readonly nonce: string;
}

/** 128 random bits, base64url (valid in a CSP nonce source). */
export function createNonce(): string {
  return randomBytes(16).toString('base64url');
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function settingsHtml(input: SettingsHtmlInput): string {
  const source = escapeAttribute(input.cspSource);
  const nonce = escapeAttribute(input.nonce);
  const policy = [
    "default-src 'none'",
    `style-src ${source}`,
    `script-src 'nonce-${nonce}'`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8">',
    `<meta http-equiv="Content-Security-Policy" content="${policy}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `<link rel="stylesheet" href="${escapeAttribute(input.styleUri)}">`,
    '<title>Deployment Settings</title>',
    '</head>',
    '<body>',
    '<div id="app"></div>',
    `<script nonce="${nonce}" src="${escapeAttribute(input.scriptUri)}"></script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
