// Run the complete behavioral suite headed and produce source-linked button click coverage.
import { defineConfig } from '@playwright/test';
import base from './playwright.config';

process.env.UI_CONTROL_COVERAGE = '1';
const port = process.env.UI_CONTROL_PORT || '63941';
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  ...base,
  outputDir: process.env.UI_CONTROL_OUTPUT || './test-results/controls',
  use: { ...base.use, baseURL, headless: false },
  reporter: [
    ['list'],
    ['json', { outputFile: process.env.UI_CONTROL_RESULTS || './test-results/control-results.json' }],
    ['html', { outputFolder: process.env.UI_CONTROL_HTML_OUTPUT || './playwright-report', open: 'never' }],
  ],
  webServer: {
    command: `node scripts/control-server.mjs ${port}`,
    url: `${baseURL}/__ui-controls`,
    reuseExistingServer: false,
    timeout: 30000,
  },
});
