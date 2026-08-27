import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

export default [
  {
    ignores: ['dist/', 'artifacts/', 'node_modules/', 'tools/*.js', '**/*.js'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      // TypeScript resolves every identifier against `lib`/`types`, so
      // `no-undef` only duplicates that check — badly, since it has no view of
      // the DOM and WebExtension type libraries.
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'prefer-const': 'error',
      'no-var': 'error',
      'no-console': 'off',
    },
  },
  {
    // Test doubles legitimately model partial browser APIs.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
];
