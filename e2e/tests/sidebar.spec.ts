import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { selectors } from '../helpers/selectors';

test.describe('Sidebar @features', () => {
  // The sidebar collapses by toggling a `collapsed` class, not by hiding the element — so that class
  // is what the click must actually flip.
  //
  // This replaces four separate tests (element attached / toggle attached / "can be toggled" /
  // "initializeSidebar exists"). Three of them booted a browser to assert existence, and the toggle
  // one clicked and then asserted `typeof className === 'string'` — true of every element on the
  // page whether the toggle works or not. Presence is now implied by clicking the thing.
  test('clicking the toggle collapses and re-expands the sidebar', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const sidebar = page.locator(selectors.sidebar);
    // There are two toggles (desktop + mobile) and only one is visible at a given viewport, so pick
    // the visible one rather than the first in DOM order.
    const visibleToggle = selectors.sidebarToggle
      .split(',')
      .map((part) => `${part.trim()}:visible`)
      .join(', ');
    const toggle = page.locator(visibleToggle).first();

    await expect(sidebar).toBeAttached();
    await expect(toggle).toBeVisible();

    const isCollapsed = () => sidebar.evaluate((el) => el.classList.contains('collapsed'));
    const collapsedBefore = await isCollapsed();

    await toggle.click();
    await expect.poll(isCollapsed).toBe(!collapsedBefore);

    await toggle.click();
    await expect.poll(isCollapsed).toBe(collapsedBefore);
  });
});
