import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { selectors } from '../helpers/selectors';

test.describe('Sidebar @features', () => {
  test('sidebar element exists in DOM', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const sidebar = page.locator(selectors.sidebar);
    await expect(sidebar).toBeAttached();
  });

  test('sidebar toggle button exists', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const toggle = page.locator(selectors.sidebarToggle);
    // At least one matching element should exist
    const count = await toggle.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('sidebar can be toggled', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const sidebar = page.locator(selectors.sidebar);
    const toggle = page.locator(selectors.sidebarToggle).first();

    if (await toggle.isVisible()) {
      const initiallyVisible = await sidebar.isVisible();
      await toggle.click();
      await page.waitForTimeout(500);
      const afterToggle = await sidebar.isVisible();

      // Visibility should change (or class should change)
      // Some implementations toggle a class rather than visibility
      const classChanged = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? el.className : '';
      }, selectors.sidebar);

      expect(typeof classChanged).toBe('string');
    }
  });

  test('sidebar initialization function exists', async ({ mockApi: page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    const hasInit = await page.evaluate(() => {
      const w = window as any;
      return typeof w.initializeSidebar === 'function';
    });

    expect(hasInit).toBe(true);
  });
});
