import globals from 'globals';
import pluginJs from '@eslint/js';
import tseslint from 'typescript-eslint';

/** @type {import('eslint').Linter.Config[]} */
export default [
  { files: ['src/*.{js,mjs,cjs,ts}'] },
  { ignores: ['node_modules/**', 'dist/**', 'out/**', '.vscode-test/**', 'temp/**'] },
  { languageOptions: { globals: globals.browser } },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-multiple-empty-lines': ['error', { max: 2, maxEOF: 1, maxBOF: 0 }],
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
];
