import {existsSync} from 'node:fs';
import {chromium, defineConfig} from '@playwright/test';

const chromePath = process.env.CHROME_PATH || chromium.executablePath();
if (!existsSync(chromePath))
  throw new Error(`Chrome was not found at ${chromePath}. Run "bunx playwright install chromium".`);

// Servers are per worker (test/browser/server-fixture.js), so files run in parallel.
export default defineConfig({
  testDir: './test/browser',
  globalSetup: './test/browser/global-setup.js',
  timeout: 45_000,
  expect: {timeout: 10_000},
  fullyParallel: true,
  workers: process.env.CI ? 4 : 6,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    headless: true,
    // Keep interaction and geometry checks independent of animation progress.
    contextOptions: {reducedMotion: 'reduce'},
    launchOptions: {executablePath: chromePath},
    trace: 'retain-on-failure',
  },
});
