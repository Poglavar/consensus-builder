import { defineConfig, devices } from '@playwright/test';
import { enableBackgroundChromium } from './helpers/background-chromium.cjs';

// Headed runs open their windows behind the active app instead of taking focus (macOS).
enableBackgroundChromium();

const baseURL = process.env.BASE_URL || 'http://localhost:8080';
const serverURL = new URL(baseURL);

// Only the wrapper passes the finished tests back to Playwright; a bare TEST_RUN would redo them.
if (process.env.TEST_RUN && !process.env.TEST_RUN_RESUMABLE) {
  throw new Error('Start a named test run with `node scripts/run-resumable.mjs <name> [args]`');
}

export default defineConfig({
  testDir: './tests',
  // Screenshot authoring is an opt-in utility, not regression coverage.
  testIgnore: process.env.CAPTURE_HOWTO ? [] : ['**/capture-howto.spec.ts'],
  outputDir: './test-results',

  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,

  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['list'],
    // Named runs (TEST_RUN=<name>) record finished tests so they can be continued; see scripts/run-resumable.mjs.
    ...(process.env.TEST_RUN ? [['./helpers/run-ledger-reporter.cjs'] as [string]] : []),
  ],

  use: {
    baseURL,
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        channel: process.env.CI ? undefined : 'chrome',
        launchOptions: {
          args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
        },
      },
    },
  ],

  /* Start a static file server if no external server is running */
  webServer: {
    command: `npx serve ../frontend -l ${serverURL.port || '8080'} --no-clipboard`,
    url: serverURL.origin,
    reuseExistingServer: true,
    timeout: 15_000,
  },
});
