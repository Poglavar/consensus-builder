import { test as base, Page } from '@playwright/test';
import { clearStorage } from './app';
import { mockAllApiRoutes } from './mocks/api-routes';

/**
 * Extended test fixtures for consensus-builder E2E tests.
 */
export const test = base.extend<{
  /** Page with API routes mocked via page.route() */
  mockApi: Page;
  /** Page with clean storage (localStorage + IndexedDB cleared) */
  cleanPage: Page;
}>({
  mockApi: async ({ page }, use) => {
    await mockAllApiRoutes(page);
    await use(page);
  },

  cleanPage: async ({ page }, use) => {
    await page.goto('/');
    await clearStorage(page);
    await page.reload();
    await use(page);
  },
});

export { expect } from '@playwright/test';
