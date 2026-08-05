import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // dist/build output, deps, workflow scratch, and vendored minified bundles
    // (e.g. the deck's anime.js) — none are our source to lint.
    ignores: ['dist/**', '**/dist-worker/**', '**/dist-worker-bundle/**', 'node_modules/**', '.workflows/**', '**/*.min.js'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Plain Node ESM scripts (e.g. bench/) — declare the Node globals they use.
    files: ['**/*.mjs', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
);
