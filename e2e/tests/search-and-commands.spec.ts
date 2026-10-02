import { test, expect } from '../helpers/fixtures';
import { openCity, PARCEL_ID } from '../helpers/runtime';

test.describe('Search and command palette @features', () => {
  test('address results use the geocoder and move the map to the selected place', async ({ mockApi: page }) => {
    const queries: string[] = [];
    await page.route('https://photon.komoot.io/api/**', route => {
      queries.push(new URL(route.request().url()).searchParams.get('q') || '');
      return route.fulfill({ json: { features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [15.975, 45.81] }, properties: { name: 'Test library', city: 'Zagreb', country: 'Croatia', osm_key: 'amenity', osm_value: 'library' } }] } });
    });
    await openCity(page);
    const search = page.getByRole('combobox', { name: 'Search the map' });
    await search.fill('Test library');
    await page.locator('.map-search__results [role="option"]').filter({ hasText: 'Test library' }).first().click();
    await expect.poll(() => page.evaluate(() => Math.abs((window as any).map.getCenter().lat - 45.81))).toBeLessThan(0.0001);
    await expect.poll(() => page.evaluate(() => Math.abs((window as any).map.getCenter().lng - 15.975))).toBeLessThan(0.0001);
    expect(queries).toContain('Test library');
    await expect(search).toHaveAttribute('aria-expanded', 'false');
  });

  test('parcel search locates the actual cadastral geometry', async ({ mockApi: page }) => {
    await openCity(page);
    const search = page.getByRole('combobox', { name: 'Search the map' });
    await search.fill(PARCEL_ID);
    await page.locator('.map-search__results [role="option"]').filter({ hasText: PARCEL_ID }).first().click();
    await expect.poll(() => page.evaluate(() => (window as any).selectedParcelId)).toBe(PARCEL_ID);
    await expect(page.locator('#parcel-info-panel')).toBeVisible();
    await expect(page.locator('#info-content')).toContainText('1234');
  });

  test('keyboard palette filters and executes toggles, reveals inputs, reports unavailable actions, and closes', async ({ mockApi: page }) => {
    await openCity(page);
    const palette = page.locator('.command-palette-backdrop');
    const input = page.locator('.command-palette__input');
    await page.keyboard.press('Meta+k');
    await expect(palette).toBeVisible();
    await input.fill('Show parcels');
    await page.keyboard.press('Enter');
    await expect(palette).toBeHidden();
    await expect.poll(() => page.evaluate(() => (window as any).map.hasLayer((window as any).parcelLayer))).toBe(false);
    await page.keyboard.press('Meta+k');
    await input.fill('Show parcels');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => (window as any).map.hasLayer((window as any).parcelLayer))).toBe(true);
    await page.keyboard.press('Meta+k');
    await input.fill('Base map');
    await page.keyboard.press('Enter');
    await expect(page.locator('#settings-sheet')).toBeVisible();
    await expect(page.locator('#tile-source-select')).toBeFocused();
    await page.keyboard.press('Escape');
    await page.locator('#settings-button').focus();
    await page.keyboard.press('Meta+k');
    await input.fill('Propose here');
    await expect(page.locator('.command-palette__item').filter({ hasText: 'Propose here' })).toHaveAttribute('aria-disabled', 'true');
    await input.fill('zzzz nonexistent action');
    await expect(page.locator('.command-palette__empty')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
  });

  test('introduction, version information and diagnostic log open, copy and close through their controls', async ({ mockApi: page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await openCity(page);
    await page.locator('#settings-button').click();
    await expect(page.locator('#version-badge')).not.toBeEmpty();
    await page.locator('#version-badge').focus();
    await page.keyboard.press('Meta+k');
    await page.locator('.command-palette__input').fill('How Consensus Builder works');
    await page.keyboard.press('Enter');
    await expect(page.locator('#site-intro-modal')).toBeVisible();
    await page.locator('.site-intro-cta').click();
    await expect(page.locator('#site-intro-modal')).toBeHidden();
    await page.keyboard.press('Meta+k');
    await page.locator('.command-palette__input').fill('Open the status log');
    await page.keyboard.press('Enter');
    await expect(page.locator('#status-log-modal')).toBeVisible();
    await expect(page.locator('#status-log-modal-list')).not.toBeEmpty();
    await page.locator('#status-log-modal-copy').click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('Loaded 5 cadastral parcels.');
    await page.locator('#status-log-modal-close').click();
    await expect(page.locator('#status-log-modal')).toBeHidden();
  });
});
