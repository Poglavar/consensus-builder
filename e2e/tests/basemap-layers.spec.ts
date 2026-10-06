import { test, expect } from '../helpers/fixtures';
import { waitForMapReady, zoomToParcelLevel } from '../helpers/app';
import { selectors } from '../helpers/selectors';

/**
 * Basemap selector and layer toggling — tile source switching, building layer visibility, city and
 * data-source choice. Since the sidebar became the map shell (UI-REWORK.md) the base-map and
 * data-source selects live in the Settings sheet (Data & maintenance), the buildings toggle in the
 * Layers sheet, and the city select was replaced by the search box's city results; the UI tests
 * below go through those sheets the way a visitor does.
 */

test.describe('Basemap and layer controls @features', () => {
  test('the Settings sheet base-map select switches the tile source', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    await page.locator(selectors.settingsButton).click();
    const select = page.locator(`${selectors.settingsSheet} #tile-source-select`);
    await expect(select).toBeVisible();
    // Should have at least OpenStreetMap and MapTiler
    await expect(select.locator('option[value="openstreetmap"]')).toHaveCount(1);
    await expect(select.locator('option[value="maptiler"]')).toHaveCount(1);

    const tileUrl = () => page.evaluate(() => (window as any).baseTileLayer?._url ?? null);
    const before = await select.inputValue();
    const beforeUrl = await tileUrl();
    const next = before === 'openstreetmap' ? 'maptiler' : 'openstreetmap';

    await select.selectOption(next);
    // The change handler (basemap.js initBasemapSelector) must swap the live Leaflet base layer.
    await expect.poll(tileUrl).not.toBe(beforeUrl);
    await expect(select).toHaveValue(next);
  });

  // These two used to call a bare `window.applyBasemap`, which the app has not exposed since
  // basemap.js moved behind the `BasemapManager` namespace — so they skipped themselves on every
  // run and the basemap switch was in truth untested. They now call the real entry point.
  test('switching tile source updates map tiles', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    // Record current tile URLs
    const beforeTiles = await page.evaluate(() => {
      const imgs = document.querySelectorAll('.leaflet-tile-pane img');
      return Array.from(imgs).slice(0, 3).map((img: any) => img.src);
    });

    // Switch to a different basemap programmatically
    const switched = await page.evaluate(() => {
      const w = window as any;
      const select = document.getElementById('tile-source-select') as HTMLSelectElement | null;
      const currentVal = select?.value ?? 'openstreetmap';
      const newVal = currentVal === 'openstreetmap' ? 'maptiler' : 'openstreetmap';

      w.BasemapManager.applyBasemap(w.map, newVal);
      return { from: currentVal, to: newVal };
    });

    // Tiles for the new source have to actually reach the tile pane.
    await expect
      .poll(async () => page.evaluate(() => {
        const imgs = document.querySelectorAll('.leaflet-tile-pane img');
        return Array.from(imgs).map((img: any) => img.src);
      }), { timeout: 15_000 })
      .not.toEqual(beforeTiles);

    const afterTiles = await page.evaluate(() => {
      const imgs = document.querySelectorAll('.leaflet-tile-pane img');
      return Array.from(imgs).slice(0, 3).map((img: any) => img.src);
    });
    expect(afterTiles.length).toBeGreaterThan(0);
    expect(afterTiles[0]).not.toBe(beforeTiles[0]);
    expect(switched.to).not.toBe(switched.from);
  });

  test('applyBasemap syncs the tile source selector back to the applied key', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      // Start from maptiler so the switch back to openstreetmap is a real change, not a no-op.
      w.BasemapManager.applyBasemap(w.map, 'maptiler');
      const afterMaptiler = (document.getElementById('tile-source-select') as HTMLSelectElement | null)?.value ?? '';
      w.BasemapManager.applyBasemap(w.map, 'openstreetmap');
      const afterOsm = (document.getElementById('tile-source-select') as HTMLSelectElement | null)?.value ?? '';
      return { afterMaptiler, afterOsm };
    });

    expect(result.afterMaptiler).toBe('maptiler');
    expect(result.afterOsm).toBe('openstreetmap');
  });

  // Replaces "buildings checkbox exists" and a toggle test that set `checked` itself and then
  // asserted it had changed. Zagreb: New York hides the Buildings section.
  test('the Layers sheet buildings toggle fetches the buildings layer', async ({ mockApi: page }) => {
    await page.goto('/?city=zg');
    await waitForMapReady(page);
    // The building toggles are enabled only at parcel zoom (map-controls.js updateParcelsCheckboxByZoom).
    await zoomToParcelLevel(page);

    await page.evaluate(() => {
      const w = window as any;
      w.__fetchBuildingsCalls = [];
      w.fetchBuildings = (bounds: unknown, options: unknown) => {
        w.__fetchBuildingsCalls.push(options ?? null);
        return Promise.resolve();
      };
    });

    await page.locator(selectors.layersButton).click();
    const checkbox = page.locator(`${selectors.layersSheet} #showBuildings`);
    await expect(checkbox).toBeVisible();
    await expect(checkbox).toBeEnabled();
    await expect(checkbox).not.toBeChecked();

    await checkbox.click();
    await expect(checkbox).toBeChecked();
    await expect.poll(() => page.evaluate(() => (window as any).__fetchBuildingsCalls.length)).toBe(1);
    const options = await page.evaluate(() => (window as any).__fetchBuildingsCalls[0]);
    expect(options).toMatchObject({ announce: true });

    // Turning it off hides the layer; it must not fetch again.
    await checkbox.click();
    await expect(checkbox).not.toBeChecked();
    expect(await page.evaluate(() => (window as any).__fetchBuildingsCalls.length)).toBe(1);
  });

  // Was "city selector exists and is populated" (#city-select, removed with the search box).
  test('the search box lists configured cities and switches to the chosen one', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);
    expect(await page.evaluate(() => (window as any).CityConfigManager.getCurrentCityId())).toBe('new_york');

    await page.locator('.map-search__icon-button').click();
    await page.locator(selectors.searchInput).fill('Belgrade');
    const result = page.locator(selectors.searchCityResult).filter({ hasText: 'Belgrade' });
    await expect(result).toHaveCount(1);

    await result.click();
    await page.waitForURL(/[?&]city=belgrade\b/);
    await waitForMapReady(page);
    expect(await page.evaluate(() => (window as any).CityConfigManager.getCurrentCityId())).toBe('belgrade');
  });

  // Was "data source selector exists". Changing the data source wipes local data, so it asks first;
  // declining must leave the select on the source still in use.
  test('the Settings sheet data-source select reverts when the wipe is declined', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    await page.evaluate(() => {
      const w = window as any;
      w.__dataSourceConfirms = 0;
      w.showStyledConfirm = async () => {
        w.__dataSourceConfirms += 1;
        return false;
      };
    });

    await page.locator(selectors.settingsButton).click();
    const select = page.locator(`${selectors.settingsSheet} #data-source-select`);
    await expect(select).toBeVisible();

    const current = await page.evaluate(() => (window as any).getCurrentDataSource());
    await expect(select).toHaveValue(current);

    const other = await select.evaluate((el, cur) => Array.from((el as HTMLSelectElement).options)
      .map((opt) => opt.value)
      .find((value) => value !== cur) ?? null, current);
    expect(other).not.toBeNull();

    await select.selectOption(other!);
    await expect.poll(() => page.evaluate(() => (window as any).__dataSourceConfirms)).toBe(1);
    await expect(select).toHaveValue(current);
    expect(await page.evaluate(() => (window as any).getCurrentDataSource())).toBe(current);
  });
});
