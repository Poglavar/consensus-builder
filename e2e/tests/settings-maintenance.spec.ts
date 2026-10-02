import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { openCity, PARCEL_ID } from '../helpers/runtime';

async function openSettings(page: import('@playwright/test').Page) {
  await page.locator('#settings-button').click();
  await expect(page.locator('#settings-sheet')).toBeVisible();
}

test.describe('Settings maintenance @features', () => {
  test('coverage opens and refreshes, and a tile preference survives reload', async ({ mockApi: page }) => {
    await openCity(page);
    await openSettings(page);
    await page.locator('#showParcelCoverageButton').click();
    const coverage = page.locator('#parcel-coverage-modal');
    await expect(coverage).toBeVisible();
    await expect(coverage.locator('#parcel-coverage-summary')).toBeVisible();
    await expect(coverage.locator('#parcel-coverage-map')).toBeVisible();
    await coverage.locator('#parcel-coverage-refresh-btn').click();
    await expect(coverage.locator('#parcel-coverage-map')).toBeVisible();
    await coverage.locator('#parcel-coverage-close-btn').click();
    await expect(coverage).toBeHidden();

    // Opening coverage owns the foreground modal and closes the sheet that opened it.
    await openSettings(page);
    const tile = page.locator('#tile-source-select');
    const original = await tile.inputValue();
    const next = original === 'openstreetmap' ? 'maptiler' : 'openstreetmap';
    await tile.selectOption(next);
    await expect.poll(() => page.evaluate(() => (window as any).baseTileLayer?._url || '')).not.toBe('');
    await page.reload();
    await waitForMapReady(page);
    await openSettings(page);
    await expect(page.locator('#tile-source-select')).toHaveValue(next);
  });

  test('debug controls reveal maintenance actions, and cancelling the all-data wipe preserves stored app data', async ({ mockApi: page }) => {
    await page.addInitScript(() => localStorage.setItem('e2e-maintenance-sentinel', 'keep-me'));
    await page.goto('/?city=zg');
    await waitForMapReady(page);
    await openSettings(page);
    const debug = page.locator('#debugModeCheckbox');
    if (!(await debug.isChecked())) await debug.check();
    await expect(page.locator('body')).toHaveClass(/debug-mode/);
    await expect(page.locator('#settings-sheet [data-section="parcels"] .btn-danger')).toBeVisible();

    const clearProposals = page.locator('#settings-sheet [data-section="proposals"] button.btn-danger');
    await clearProposals.click();
    await expect(page.locator('#floating-status-text')).toContainText(/Cleared .*proposal/i);

    const wipe = page.locator('#wipeLocalDataButton');
    await wipe.click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText(/ALL locally stored data|ALL local data/i);
    await confirm.getByRole('button', { name: /cancel/i }).click();
    await expect(confirm).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('e2e-maintenance-sentinel'))).toBe('keep-me');
    await page.reload();
    await waitForMapReady(page);
    expect(await page.evaluate(() => localStorage.getItem('e2e-maintenance-sentinel'))).toBe('keep-me');
  });

  test('parcel, block, and road clear controls remove their actual stored or projected state', async ({ mockApi: page }) => {
    await openCity(page);
    await page.locator('#settings-button').click();
    const debug = page.locator('#debugModeCheckbox');
    if (!(await debug.isChecked())) await debug.check();

    const seeded = await page.evaluate((parcelId) => {
      const w = window as any;
      const layer = w.ParcelPresenter.getLayer(parcelId);
      if (!layer) throw new Error(`Fixture parcel ${parcelId} did not load`);
      w.PersistentStorage.setItem('parcel_e2e-maintenance_geometry', '{}');
      w.addRoadParcel(parcelId);
      w.blockStorage.addBlock('E2E maintenance block', [layer]);
      return { roadCount: w.getRoadParcelCount(), blockCount: w.blockStorage.blocks.size };
    }, PARCEL_ID);
    expect(seeded.roadCount).toBeGreaterThan(0);
    expect(seeded.blockCount).toBeGreaterThan(0);

    await page.locator('#settings-sheet [data-section="blocks"] button.btn-danger').click();
    await expect.poll(() => page.evaluate(() => (window as any).blockStorage.blocks.size)).toBe(0);
    await expect(page.locator('#floating-status-text')).toContainText(/Cleared .* blocks/i);

    await page.locator('#settings-sheet [data-section="roads"] button.btn-danger').click();
    await expect.poll(() => page.evaluate(() => (window as any).getRoadParcelCount())).toBe(0);
    await expect(page.locator('#floating-status-text')).toContainText(/Cleared .* road parcels/i);

    await page.locator('#settings-sheet [data-section="parcels"] button.btn-danger').click();
    await expect.poll(() => page.evaluate(() => (window as any).PersistentStorage.getItem('parcel_e2e-maintenance_geometry'))).toBeNull();
    await expect(page.locator('#floating-status-text')).toContainText(/Cleared .* parcel-related items/i);
    await expect.poll(() => page.evaluate(() => (window as any).selectedParcelId)).toBeNull();
  });

  test('confirming the all-data wipe clears local storage and persistent app data across reload', async ({ mockApi: page }) => {
    await page.goto('/?city=zg');
    await waitForMapReady(page);
    await page.evaluate(() => {
      localStorage.setItem('e2e-wipe-sentinel', 'remove-me');
      (window as any).PersistentStorage.setItem('e2e-wipe-persistent', 'remove-me');
    });
    await openSettings(page);
    await page.locator('#wipeLocalDataButton').click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText(/ALL locally stored data|ALL local data/i);
    const reloaded = page.waitForNavigation();
    await confirm.getByRole('button', { name: /^OK$/i }).click();
    await reloaded;
    await waitForMapReady(page);
    await expect.poll(() => page.evaluate(() => localStorage.getItem('e2e-wipe-sentinel'))).toBeNull();
    await expect.poll(() => page.evaluate(() => (window as any).PersistentStorage.getItem('e2e-wipe-persistent'))).toBeNull();
    await page.reload();
    await waitForMapReady(page);
    expect(await page.evaluate(() => localStorage.getItem('e2e-wipe-sentinel'))).toBeNull();
    expect(await page.evaluate(() => (window as any).PersistentStorage.getItem('e2e-wipe-persistent'))).toBeNull();
  });

  test('declining a data-source change keeps the current source and its stored selection', async ({ mockApi: page }) => {
    await page.goto('/?city=zg');
    await waitForMapReady(page);
    await openSettings(page);
    const select = page.locator('#data-source-select');
    const current = await select.inputValue();
    const next = await select.locator('option').evaluateAll((options, value) =>
      options.map(option => (option as HTMLOptionElement).value).find(value2 => value2 !== value), current);
    expect(next).toBeTruthy();
    await select.selectOption(next!);
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: /cancel/i }).click();
    await expect(select).toHaveValue(current);
    await page.reload();
    await waitForMapReady(page);
    await openSettings(page);
    await expect(page.locator('#data-source-select')).toHaveValue(current);
  });

  test('Use my location asks permission and opens the nearest configured city', async ({ mockApi: page }) => {
    await page.context().grantPermissions(['geolocation']);
    await page.context().setGeolocation({ latitude: 45.815, longitude: 15.982 });
    await page.goto('/?city=zg');
    await waitForMapReady(page);
    // The city chip can open World view when that entry is available. Open search with its
    // dedicated control; the empty-query Cities group contains the supported location action.
    await page.locator('.map-search__icon-button').click();
    const location = page.locator('.map-search__results [role="option"]').filter({ hasText: /Use my location/i });
    await expect(location).toBeVisible();
    await location.click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText(/use your approximate location/i);
    const reloaded = page.waitForNavigation();
    await confirm.getByRole('button', { name: /^OK$/i }).click();
    await reloaded;
    await waitForMapReady(page);
    await expect.poll(() => page.evaluate(() => (window as any).CityConfigManager.getCurrentCityId())).toBe('zagreb');
  });
});
