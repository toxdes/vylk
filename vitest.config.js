import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    environment: 'node',
    // Each file gets its own module graph, so its in-memory IndexedDB is private to that file.
    testTimeout: 10000,
  },
});
