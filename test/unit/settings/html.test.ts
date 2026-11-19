import { describe, expect, it } from 'vitest';
import { createNonce, settingsHtml } from '../../../src/settings/html';

const input = {
  cspSource: 'https://file+.vscode-resource.vscode-cdn.net',
  scriptUri: 'https://file+.vscode-resource.vscode-cdn.net/ext/dist/webview/main.js',
  styleUri: 'https://file+.vscode-resource.vscode-cdn.net/ext/dist/webview/style.css',
  nonce: 'abc123',
};

function csp(html: string): string {
  const match = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html);
  if (match?.[1] === undefined) {
    throw new Error('no CSP meta element');
  }
  return match[1];
}

describe('settingsHtml', () => {
  it('has a strict Content Security Policy with a nonce for the one script', () => {
    const html = settingsHtml(input);
    expect(csp(html).split('; ')).toEqual([
      "default-src 'none'",
      `style-src ${input.cspSource}`,
      "script-src 'nonce-abc123'",
      "base-uri 'none'",
      "form-action 'none'",
    ]);
    expect(html.match(/<script /g)).toHaveLength(1);
    expect(html).toContain(`<script nonce="abc123" src="${input.scriptUri}"></script>`);
    expect(html).toContain(`<link rel="stylesheet" href="${input.styleUri}">`);
  });

  it('has no inline script, style or event handler', () => {
    const html = settingsHtml(input);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/<style|style=/i);
    expect(html).not.toMatch(/<script[^>]*>[^<]/);
  });

  it('escapes the values it is given', () => {
    const html = settingsHtml({ ...input, scriptUri: 'x"><img src=x onerror=alert(1)>' });
    expect(html).not.toContain('<img');
    expect(html).toContain('x&quot;&gt;&lt;img');
  });

  it('creates a different unguessable nonce each time', () => {
    const nonces = new Set(Array.from({ length: 50 }, () => createNonce()));
    expect(nonces.size).toBe(50);
    for (const nonce of nonces) {
      expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    }
  });
});
