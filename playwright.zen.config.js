import {defineConfig} from '@playwright/test';
import base from './playwright.config.js';

// These fixtures load shipped assets directly; they never start a Vylk server.
export default defineConfig({
  ...base,
  webServer: undefined,
  testMatch: 'zen-inline-toolbar.spec.js',
});
