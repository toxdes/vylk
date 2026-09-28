import base from './playwright.config.js';

export default {
  ...base,
  testIgnore: [],
  testMatch: ['**/vault.spec.js'],
};
