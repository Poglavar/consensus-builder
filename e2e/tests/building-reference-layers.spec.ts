import { openLayerSection } from '../helpers/layers';
// Zagreb's building surveys, and the one rule that must never bend: what a corridor CUTS is decided
// by the buildings of the sources in use (the pool), never by what the user happens to have switched on.
//
// GDI (gdi_building_footprint, object_id) is Zagreb's source in use; DGU (dgu_building, zgrada_id)
// and OpenStreetMap are listed for comparison. Each building is keyed `<source>:<id>`.
//
// These tests cover:
//   1. a building's key names its source, so two surveys' ids never collide
//   2. detection reads the DATA, not the Leaflet layer, so a cosmetic toggle cannot change the cut
//   3. B opens the Buildings switch and the building source list, applied at once

import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { installLayerDatasets } from '../helpers/mocks/layer-datasets';

// A GDI footprint as it lands in the pool from a gdi-3d cell: its object_id and its source.
const GDI_FEATURE = {
  type: 'Feature',
  properties: { id: 61075, source: 'gdi-3d', height_m: 14.2 },
  geometry: {
    type: 'Polygon',
    coordinates: [[
      [15.98208, 45.80008], [15.98224, 45.80008], [15.98224, 45.80022], [15.98208, 45.80022], [15.98208, 45.80008],
    ]],
  },
};

// The footprint cells, as POST /buildings/cell answers each source (flat items).
async function installSurveyRoutes(page: import('@playwright/test').Page) {
  await page.route('**/buildings/cell', async route => {
    const body = route.request().postDataJSON();
    if (body.kind !== 'footprints') return route.fallback();
    const items = body.source === 'dgu' ? [{ id: 999888, geometry: DGU_FEATURE.geometry }]
      : body.source === 'gdi-3d' ? [{ id: 61075, geometry: GDI_FEATURE.geometry, height_m: 14.2 }] : [];
    return route.fulfill({ json: { supported: true, kind: body.kind, bbox: body.bbox, complete: true, items } });
  });
}

// The same building as the CADASTRE has it — different key space entirely. If this ever ends up in
// the pool, detection is scanning the wrong survey again.
const DGU_FEATURE = {
  type: 'Feature',
  properties: { id: 999888, source: 'dgu' },
  geometry: GDI_FEATURE.geometry,
};

test.describe('Building reference layers @features', () => {
  test('a building key names its source, so two surveys of the same building never share one', async ({ mockApi: page }) => {
    await page.goto('/?city=zg');
    await waitForMapReady(page);
    const keys = await page.evaluate(([gdi, dgu]) => [(window as any).corridorBuildingKey(gdi), (window as any).corridorBuildingKey(dgu)],
      [GDI_FEATURE, DGU_FEATURE]);
    expect(keys).toEqual(['gdi-3d:61075', 'dgu:999888']);
  });

  test('detection reads the POOL, so cutting is independent of every layer toggle', async ({ mockApi: page }) => {
    await installSurveyRoutes(page);
    await page.goto('/?city=zg');
    await waitForMapReady(page);
    await page.evaluate(() => (window as any).map.setView([45.80015, 15.98216], 18, { animate: false }));
    await openLayerSection(page, 'buildings');
    const gdi = page.locator('#showBuildings');
    await gdi.check();
    await expect.poll(() => page.evaluate(() => ((window as any).buildingFeaturePool || []).some((feature: any) => feature.properties.source === 'gdi-3d' && feature.properties.id === 61075))).toBe(true);

    const detect = () => page.evaluate(() => {
      const ring = [
        { lat: 45.79998, lng: 15.98198 },
        { lat: 45.79998, lng: 15.98234 },
        { lat: 45.80030, lng: 15.98234 },
        { lat: 45.80030, lng: 15.98198 },
      ];
      return (window as any).detectLoadedBuildingTunnelIntersections(ring).map((hit: any) => hit.id);
    });
    const shown = await detect();
    await gdi.uncheck();
    await expect.poll(() => page.evaluate(() => !(window as any).map.hasLayer((window as any).buildingLayer))).toBe(true);
    const hidden = await detect();
    await gdi.check();
    const shownAgain = await detect();

    // The corridor cuts the same building no matter what is switched on. This is the assertion the
    // whole refactor exists for: detection used to read window.buildingLayer, so unticking a box
    // literally removed buildings from the set that could be demolished.
    expect(hidden).toEqual(['gdi-3d:61075']);
    expect(shownAgain).toEqual(['gdi-3d:61075']);
    expect(shown).toEqual(['gdi-3d:61075']);
  });

  test('the Buildings layer loads and renders returned survey geometry when checked', async ({ mockApi: page }) => {
    await installSurveyRoutes(page);
    await page.goto('/?city=zg');
    await waitForMapReady(page);
    await page.evaluate(() => (window as any).map.setView([45.80015, 15.98216], 18, { animate: false }));
    await openLayerSection(page, 'buildings');
    await page.locator('#showBuildings').check();
    await expect.poll(() => page.evaluate(() => ((window as any).buildingFeaturePool || []).some((feature: any) => feature.properties.source === 'gdi-3d' && feature.properties.id === 61075))).toBe(true);
    await expect.poll(() => page.evaluate(() => {
      let found = false;
      (window as any).map.eachLayer((layer: any) => layer.eachLayer?.((child: any) => { if (child.feature?.properties?.id === 61075) found = true; }));
      return found;
    })).toBe(true);
  });

  test('B opens the Buildings switch and the source list, as on the map', async ({ mockApi: page }) => {
    await installSurveyRoutes(page);
    await page.goto('/?city=zg');
    await waitForMapReady(page);
    await page.evaluate(() => (window as any).map.setView([45.80015, 15.98216], 18, { animate: false }));
    await openLayerSection(page, 'buildings');
    await page.locator('#showBuildings').check();
    await expect.poll(() => page.evaluate(() => (window as any).map.hasLayer((window as any).buildingLayer))).toBe(true);

    // Move keyboard focus out of the layer checkbox and close the layers sheet, as a user would
    // before invoking the global B shortcut.
    await page.locator('#layers-button').click();
    await page.keyboard.press('b');
    const dialog = page.locator('.building-layers-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('switch', { name: 'Show buildings' })).toBeChecked();
    // The same rows as the Building sources dialog, in the city's order.
    await expect(dialog.locator('.source-list-editor__row')).toHaveText([/GDI/, /DGU/, /OpenStreetMap/]);

    // Pressing B again while it is up must not stack a second dialog behind the first.
    await page.keyboard.press('b');
    await expect(dialog).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('B applies the Buildings switch and the source list at once; Enter and Escape only close', async ({ mockApi: page }) => {
    await installLayerDatasets(page);
    await installSurveyRoutes(page);
    await page.goto('/?city=zg');
    await waitForMapReady(page);
    await page.evaluate(() => (window as any).map.setView([45.80015, 15.98216], 18, { animate: false }));
    await openLayerSection(page, 'buildings');
    await page.locator('#showBuildings').uncheck();
    await page.locator('#layers-button').click();
    const shown = () => page.evaluate(() => (document.getElementById('showBuildings') as HTMLInputElement).checked);
    const outlined = () => page.evaluate(() => {
      const w = window as any;
      return w.SourceList.outlined(w.SourceList.forConfig(w.CityConfigManager.getCurrentCityConfig(), w)).map((entry: any) => entry.id);
    });

    await page.keyboard.press('b');
    const dialog = page.locator('.building-layers-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('switch', { name: 'Show buildings' }).check();
    await expect.poll(shown).toBe(true);
    await dialog.locator('.source-list-editor__row').nth(1).getByRole('switch', { name: 'Outline' }).check();
    await expect.poll(outlined).toEqual(['dgu']);
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    expect(await shown()).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as any).map.hasLayer((window as any).buildingLayer))).toBe(true);

    // Escape closes; what was switched stays switched.
    await page.keyboard.press('b');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('switch', { name: 'Show buildings' }).uncheck();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(await shown()).toBe(false);
    expect(await outlined()).toEqual(['dgu']);
  });
});
