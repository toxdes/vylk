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
      'static/marked.min.js',
      'test-results/**',
      'yesb/**',
    ],
  },
  {
    ...js.configs.recommended,
    files: ['static/*.js'],
    ignores: ['static/*.test.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: sourceGlobals,
    },
    rules: {
      // These helpers are exposed through the test hook bridge rather than
      // referenced statically by the browser script.
      'no-unused-vars': ['error', {
        args: 'none',
        caughtErrors: 'none',
        varsIgnorePattern: '^(applyRemoteDeletion|cacheRemoteNote|claimQueueOperation|getOfflineDatabaseInfo)$',
      }],
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
    ...js.configs.recommended,
    files: ['*.config.js', 'static/*.test.js', 'test/**/*.js'],
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
