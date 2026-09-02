import { defineConfig } from '@playwright/test';

import baseConfig from './playwright.config';

export default defineConfig({
  ...baseConfig,
  testIgnore: [],
  testMatch: '**/capture.spec.ts',
  retries: 0,
  reporter: 'list',
});
