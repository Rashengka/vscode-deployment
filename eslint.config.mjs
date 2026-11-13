// @ts-check
import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/', 'out/', 'coverage/', '.vscode-test/', 'node_modules/'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // The extension loads ssh2 only through the separately bundled dist/ssh2.js.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^ssh2(/|$)',
              allowTypeImports: true,
              message: 'Import ssh2 only in src/ssh/ssh2Bundle.ts (bundled as dist/ssh2.js).',
            },
          ],
        },
      ],
      'no-console': 'error',
    },
  },
  {
    files: ['src/ssh/ssh2Bundle.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['scripts/**', 'test/**', '*.mts', '*.mjs'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['test/extension/**'],
    languageOptions: { globals: { ...globals.mocha } },
  },
  {
    files: ['**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
