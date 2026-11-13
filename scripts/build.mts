/**
 * Bundles the extension into `dist/`.
 *
 * - `dist/extension.js`: the extension entry point (`vscode` stays external).
 * - `dist/ssh2.js`: ssh2 and its pure JavaScript dependencies. The native crypto addon
 *   (`*.node`) and `cpu-features` are replaced with modules that throw when required, so the
 *   bundle never tries to load native code and behaves the same on every platform.
 * - `dist/kdfWorker.js`: the worker thread that derives keys of encrypted OpenSSH keys.
 *
 * Usage: node scripts/build.mts [--production]
 */
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const repoRoot = resolve(import.meta.dirname, '..');

const NATIVE_STUB_NAMESPACE = 'native-addon-stub';

const excludeNativeAddons: esbuild.Plugin = {
  name: 'exclude-native-addons',
  setup(build) {
    build.onResolve({ filter: /^cpu-features$|\.node$/ }, (args) => ({
      path: args.path,
      namespace: NATIVE_STUB_NAMESPACE,
    }));
    build.onLoad({ filter: /.*/, namespace: NATIVE_STUB_NAMESPACE }, (args) => ({
      contents: `throw new Error(${JSON.stringify(`Native module "${args.path}" is not bundled.`)});`,
      loader: 'js',
    }));
  },
};

// Start from an empty dist/ so that stale files (e.g. source maps of a dev build) never get packaged.
rmSync(join(repoRoot, 'dist'), { recursive: true, force: true });

await esbuild.build({
  absWorkingDir: repoRoot,
  entryPoints: {
    extension: 'src/extension.ts',
    ssh2: 'src/ssh/ssh2Bundle.ts',
    kdfWorker: 'src/ssh/kdfWorker.ts',
  },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  // VS Code 1.144 runs extensions on Electron with Node.js 24.
  target: 'node24',
  format: 'cjs',
  external: ['vscode'],
  plugins: [excludeNativeAddons],
  minify: production,
  sourcemap: !production,
  // Keep license comments of bundled dependencies in the shipped files.
  legalComments: 'inline',
  logLevel: 'info',
});
