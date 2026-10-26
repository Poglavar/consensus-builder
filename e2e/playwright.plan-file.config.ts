// Portable-file fixtures supply their own DOM and local scripts; no app/source server is needed.
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  testMatch: 'plan-file.spec.ts',
  workers: 1,
  reporter: 'list',
  use: { headless: true },
});
