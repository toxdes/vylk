import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    environment: 'node',
    // Behavior suites intentionally share the browser's fixed IndexedDB name.
    // Serial files preserve the real single-origin storage model and prevent cleanup races.
    fileParallelism: false,
    testTimeout: 10000,
  },
});
