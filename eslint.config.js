import js from '@eslint/js';
import globals from 'globals';

const sourceGlobals = {
  ...globals.browser,
  ...globals.worker,
  marked: 'readonly',
  module: 'readonly',
  VylkInteractive: 'readonly',
  VylkMerge: 'readonly',
};

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'playwright-report/**',
      'internal/web/static/vendor/marked.min.js',
      'test-results/**',
      'yesb/**',
    ],
  },
  {
    ...js.configs.recommended,
    files: ['internal/web/static/**/*.js'],
    ignores: ['internal/web/static/**/*.test.js', 'internal/web/static/vendor/**'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: sourceGlobals,
    },
    rules: {
      'no-unused-vars': [
        'error',
        {
          args: 'none',
          caughtErrors: 'none',
          ignoreRestSiblings: true,
        },
      ],
      // Best-effort cleanup and optional browser APIs intentionally ignore
      // failures in this client-side code.
      'no-empty': ['error', {allowEmptyCatch: true}],
      'no-control-regex': 'off',
      'no-extra-boolean-cast': 'off',
      'no-useless-assignment': 'off',
      'no-useless-escape': 'off',
    },
  },
  {
    files: ['internal/web/static/js/core/vault-kdf-worker.js'],
    languageOptions: {sourceType: 'module'},
  },
  {
    ...js.configs.recommended,
    files: ['*.config.js', 'internal/web/static/**/*.test.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.worker,
      },
    },
  },
];
