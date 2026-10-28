// Run the same behavioral suite in either browser mode with source-linked interaction coverage.
import { defineConfig } from '@playwright/test';
import base from './playwright.config';

process.env.UI_CONTROL_COVERAGE = '1';
const port = process.env.UI_CONTROL_PORT || '63941';
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  ...base,
  outputDir: process.env.UI_CONTROL_OUTPUT || './test-results/controls',
  use: { ...base.use, baseURL, headless: process.env.UI_CONTROL_HEADLESS === '1' },
  reporter: [
    ['list'],
    ['json', { outputFile: process.env.UI_CONTROL_RESULTS || './test-results/control-results.json' }],
    ['html', { outputFolder: process.env.UI_CONTROL_HTML_OUTPUT || './playwright-report', open: 'never' }],
    // Named runs keep each test's coverage in the ledger, so a killed run continues; see scripts/run-controls.mjs.
    ...(process.env.TEST_RUN ? [['./helpers/run-ledger-reporter.cjs'] as [string]] : []),
  ],
  webServer: {
    command: `node scripts/control-server.mjs ${port}`,
    url: `${baseURL}/__ui-controls`,
    reuseExistingServer: false,
    timeout: 30000,
  },
});
