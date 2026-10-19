import { test as base, BrowserContext, Page } from '@playwright/test';
import { clearStorage } from './app';
import { mockAllApiRoutes } from './mocks/api-routes';
import { recordControlCoverage, ObserveContexts } from './control-coverage';

/**
 * Extended test fixtures for consensus-builder E2E tests.
 */
export const test = base.extend<{
  /**
   * City pointer stored before the app boots, so a plain `goto('/')` lands in a city instead of the
   * first-visit world view (the globe covers the app when no city is stored and the URL has no
   * `?city=`). `?city=` in a URL still wins. `test.use({ seedCity: null })` opts out, for specs that
   * exercise the first visit itself.
   */
  seedCity: string | null;
  /** Page with API routes mocked via page.route() */
  mockApi: Page;
  /** Page with clean storage (localStorage + IndexedDB cleared) */
  cleanPage: Page;
  uncaughtPageErrors: void;
  controlCoverage: void;
  observeContexts: ObserveContexts;
}>({
  seedCity: ['new_york', { option: true }],

  // Shared-link and multi-device tests create extra contexts. Audit those before the first page
  // opens too, so their clicks and exceptions cannot disappear from the report.
  observeContexts: async ({ browser, context }, use) => {
    const contexts = new Set<BrowserContext>([context]);
    const observers: Array<(context: BrowserContext) => void | Promise<void>> = [];
    const originalNewContext = browser.newContext;
    const newContext: typeof browser.newContext = async options => {
      const created = await originalNewContext.call(browser, options);
      contexts.add(created);
      for (const observe of observers) await observe(created);
      return created;
    };
    browser.newContext = newContext;
    try {
      await use(async observe => {
        observers.push(observe);
        for (const created of contexts) await observe(created);
      });
    } finally {
      if (browser.newContext === newContext) browser.newContext = originalNewContext;
    }
  },

  controlCoverage: [async ({ observeContexts }, use, testInfo) => {
    await recordControlCoverage(observeContexts, testInfo, use);
  }, { auto: true }],

  // Includes fresh tabs used to open shared links, and tests that use `page` directly.
  uncaughtPageErrors: [async ({ observeContexts }, use) => {
    const errors: string[] = [];
    const contexts: BrowserContext[] = [];
    const watch = (page: Page) => page.on('pageerror', error => errors.push(error.message));
    await observeContexts(context => {
      contexts.push(context);
      context.pages().forEach(watch);
      context.on('page', watch);
    });
    await use();
    contexts.forEach(context => context.off('page', watch));
    assertNoPageErrors(errors);
  }, { auto: true }],

  mockApi: async ({ page, seedCity }, use) => {
    await mockAllApiRoutes(page);
    await seedStoredCity(page, seedCity);
    const errors = failOnPageErrors(page);
    await use(page);
    assertNoPageErrors(errors);
  },

  cleanPage: async ({ page, seedCity }, use) => {
    await seedStoredCity(page, seedCity);
    const errors = failOnPageErrors(page);
    await page.goto('/');
    await clearStorage(page);
    await page.reload();
    await use(page);
    assertNoPageErrors(errors);
  },
});

// Runs before every document's scripts (including after a reload), and only fills an EMPTY pointer:
// a city the app stored itself (setCurrentCityId, a ?city= link) is left alone. The key and the
// "no stored city opens the globe" rule live in frontend/js/city-config.js and
// frontend/js/world/world-entry-model.js (bootDecision).
async function seedStoredCity(page: Page, cityId: string | null): Promise<void> {
  if (!cityId) return;
  await page.addInitScript((id) => {
    try {
      if (!localStorage.getItem('cb_current_city')) localStorage.setItem('cb_current_city', id);
      // City-focused regressions start after the welcome flow. First-visit specs opt out with seedCity: null.
      localStorage.setItem('cb_site_intro_seen_v1', '1');
    } catch (_) { /* about:blank and opaque origins have no storage */ }
  }, cityId);
}

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
