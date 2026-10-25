import { test, expect } from '../helpers/fixtures';
import { openCity } from '../helpers/runtime';

test.describe('Remaining reachable actions @features', () => {
  test('Choose how to continue opens the parcel fallback options from its failure banner', async ({ mockApi: page }) => {
    await openCity(page);
    await page.evaluate(() => {
      (window as any).ParcelSourceSettings.reportFailure(window, 'Fixture parcel source unavailable.', 'parcel');
    });
    const banner = page.locator('#parcel-source-status');
    await expect(banner).toBeVisible();
    await banner.getByRole('button', { name: 'Choose how to continue', exact: true }).click();
    const dialog = page.locator('.ground-fallback-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-option="without-parcels"]')).toBeVisible();
    // The selected option persists the source choice and reloads through the app boundary.
    const reload = page.waitForNavigation();
    await dialog.locator('[data-option="without-parcels"]').click();
    await reload;
    await expect.poll(() => page.evaluate(() => {
      const w = window as any;
      return w.ParcelGroundFallback.isWithoutParcels(w.CityConfigManager.getCurrentCityId());
    })).toBe(true);
  });
});
