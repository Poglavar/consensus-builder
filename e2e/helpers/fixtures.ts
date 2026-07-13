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
    const errors = failOnPageErrors(page);
    await use(page);
    assertNoPageErrors(errors);
  },

  cleanPage: async ({ page }, use) => {
    const errors = failOnPageErrors(page);
    await page.goto('/');
    await clearStorage(page);
    await page.reload();
    await use(page);
    assertNoPageErrors(errors);
  },
});

// An uncaught page error means the app is broken, whatever else the test went on to assert.
//
// This exists because a ReferenceError in the tail of onParcelClick once left the ENTIRE suite green
// while parcel selection was dead: showParcelInfoPanel() runs before the throw, so "the panel opens"
// still passed, and every other spec only asserted that functions exist. Failing here is what turns
// those existence checks into something that can actually catch a broken app.
function failOnPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

function assertNoPageErrors(errors: string[]): void {
  if (!errors.length) return;
  throw new Error(`Uncaught page error(s) — the app threw while this test ran:\n  - ${errors.join('\n  - ')}`);
}

export { expect } from '@playwright/test';
