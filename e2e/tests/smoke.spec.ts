import { test, expect } from '../helpers/fixtures';
import { selectors } from '../helpers/selectors';
import { waitForMapReady, collectConsoleErrors, collectPageErrors } from '../helpers/app';

test.describe('Smoke tests @smoke', () => {
  test('page loads without critical JS errors', async ({ mockApi: page }) => {
    const pageErrors = collectPageErrors(page);

    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    // Filter out non-critical errors (CDN load failures, optional modules)
    const criticalErrors = pageErrors.filter((err) => {
      const msg = err.message || '';
      // SyntaxError from optional CDN scripts (Solana, ethers, etc.)
      if (msg.includes('Unexpected token')) return false;
      // Optional globals that may not be defined in static-serve mode
      if (msg.includes('is not defined')) return false;
      return true;
    });

    expect(criticalErrors).toEqual([]);
  });

  test('Leaflet map container is visible', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const map = page.locator(selectors.leafletContainer);
    await expect(map).toBeVisible();
  });

  test('key globals are initialized', async ({ mockApi: page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    const globals = await page.evaluate(() => {
      const w = window as any;
      return {
        hasCityConfigManager: typeof w.CityConfigManager !== 'undefined',
        hasPersistentStorage: typeof w.PersistentStorage !== 'undefined',
        hasI18n: typeof w.i18n !== 'undefined',
        hasMap: typeof w.map !== 'undefined',
        hasEnvironment: typeof w.current_environment === 'string',
      };
    });

    expect(globals.hasCityConfigManager).toBe(true);
    expect(globals.hasPersistentStorage).toBe(true);
    expect(globals.hasI18n).toBe(true);
    expect(globals.hasEnvironment).toBe(true);
  });

  test('no network requests return 5xx', async ({ mockApi: page }) => {
    const serverErrors: string[] = [];
    page.on('response', (response) => {
      if (response.status() >= 500) {
        serverErrors.push(`${response.status()} ${response.url()}`);
      }
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    expect(serverErrors).toEqual([]);
  });

  test('sidebar element is present', async ({ mockApi: page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    const sidebar = page.locator(selectors.sidebar);
    // Sidebar may or may not be visible by default, but the element should exist
    await expect(sidebar).toBeAttached();
  });
});
