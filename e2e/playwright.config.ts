import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.BASE_URL || 'http://localhost:8080';
const serverURL = new URL(baseURL);

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
