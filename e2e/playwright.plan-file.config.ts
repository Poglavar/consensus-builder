// Portable-file fixtures supply their own DOM and local scripts; no app/source server is needed.
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  testMatch: 'plan-file.spec.ts',
  workers: 1,
  reporter: 'list',
  // Relative navigation and uploads resolve against the same secure loopback origin in every test.
  // The fixture intercepts navigation before it reaches a server.
  use: { headless: true, baseURL: 'http://127.0.0.1' },
});
