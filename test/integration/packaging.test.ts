import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { join } from 'node:path';
import { describe, expect, inject, it } from 'vitest';
import { checkVsixEntries } from '../../scripts/lib/vsixAllowlist.mts';
import { listVsixEntries } from '../../scripts/lib/vsix.mts';
import type { Ssh2BundleModule } from '../support/ssh2Probe';

/** Matches a `require()` of a native addon or of `cpu-features`, minified or not. */
const NATIVE_REQUIRE = /require\(\s*["'`](?:[^"'`]*\.node|cpu-features)["'`]\s*\)/;

describe('packaged extension (.vsix)', () => {
  const vsixFile = inject('vsixFile');
  const unpackedExtension = inject('unpackedExtension');
  const distDir = join(unpackedExtension, 'dist');

  it('contains only allowlisted files', () => {
    const entries = listVsixEntries(vsixFile);
    expect(entries.length).toBeGreaterThan(0);
    expect(checkVsixEntries(entries)).toEqual({ disallowed: [], missing: [] });
  });

  it('ships no node_modules and no native addon files', () => {
    expect(existsSync(join(unpackedExtension, 'node_modules'))).toBe(false);
    const files = readdirSync(unpackedExtension, { recursive: true, encoding: 'utf8' });
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((file) => file.endsWith('.node'))).toEqual([]);
  });

  it('detects a native require in the pattern self-check', () => {
    expect(NATIVE_REQUIRE.test('x=require("./crypto/build/Release/sshcrypto.node")')).toBe(true);
    expect(NATIVE_REQUIRE.test("require('cpu-features')()")).toBe(true);
    expect(NATIVE_REQUIRE.test('require("crypto")')).toBe(false);
  });

  it('has no require() of *.node or cpu-features in any bundled file', () => {
    const bundles = readdirSync(distDir).filter((file) => file.endsWith('.js'));
    expect(bundles.sort()).toEqual(['extension.js', 'kdfWorker.js', 'ssh2.js']);
    let scannedBytes = 0;
    for (const bundle of bundles) {
      const content = readFileSync(join(distDir, bundle), 'utf8');
      scannedBytes += content.length;
      expect(NATIVE_REQUIRE.test(content), bundle).toBe(false);
    }
    expect(scannedBytes).toBeGreaterThan(100_000);
  });

  it('requires nothing but Node.js built-ins (and vscode) at runtime', () => {
    const required = new Set<string>();
    for (const bundle of ['extension.js', 'kdfWorker.js', 'ssh2.js']) {
      const content = readFileSync(join(distDir, bundle), 'utf8');
      for (const match of content.matchAll(/require\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
        required.add(match[1] ?? '');
      }
    }
    expect(required.size).toBeGreaterThan(5);
    expect([...required].filter((name) => !isBuiltin(name) && name !== 'vscode')).toEqual([]);
  });

  it('loads ssh2 from the unpacked bundle without the native crypto binding', () => {
    const bundlePath = join(distDir, 'ssh2.js');
    const requireFromPackage = createRequire(bundlePath);
    const ssh2 = requireFromPackage(bundlePath) as Ssh2BundleModule;

    expect(typeof ssh2.Client).toBe('function');
    // With ignore-scripts the addon is never built, so this holds even for a wrong bundle; the
    // decisive guards are the require() and no-.node checks above.
    expect(ssh2.nativeCryptoBindingAvailable).toBe(false);
  });
});
