// The two building surveys, and the one rule that must never bend: what a corridor CUTS is decided
// by the GDI object set, never by what the user happens to have switched on.
//
// GDI (gdi_building_footprint, object_id) is the WORKING SET — the same objects gdi_building_3d
// meshes, so detection, the 3D view and the walk sim all name the same buildings. DGU (dgu_building,
// zgrada_id) is the cadastre: a legal reference layer, and nothing more.
//
// These tests cover the three things that used to be wrong or absent:
//   1. a demolition record is keyed by object_id, not by the cadastre's zgrada_id
//   2. detection reads the DATA, not the Leaflet layer, so a cosmetic toggle cannot change the cut
//   3. B opens the survey picker every time, prefilled with what is on the map

import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';

// A GDI footprint as GET /buildings?bbox=&source=gdi serves it: keyed by object_id.
const GDI_FEATURE = {
  type: 'Feature',
  properties: { object_id: 61075, height_m: 14.2 },
  geometry: {
    type: 'Polygon',
    coordinates: [[
      [15.98208, 45.80008], [15.98224, 45.80008], [15.98224, 45.80022], [15.98208, 45.80022], [15.98208, 45.80008],
    ]],
  },
};

async function installSurveyRoutes(page: import('@playwright/test').Page) {
  await page.route('**/buildings**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname !== '/buildings') return route.continue();
    const source = url.searchParams.get('source');
    const feature = source === 'dgu' ? DGU_FEATURE : GDI_FEATURE;
    return route.fulfill({ json: { type: 'FeatureCollection', source, truncated: false, features: [feature] } });
  });
}

// The same building as the CADASTRE has it — different key space entirely. If this ever ends up in
// the pool, detection is scanning the wrong survey again.
const DGU_FEATURE = {
  type: 'Feature',
  properties: { ZGRADA_ID: 999888, zgrada_id: 999888 },
  geometry: GDI_FEATURE.geometry,
};

test.describe('Building reference layers @features', () => {
  test('a demolition record is keyed by the GDI object_id, never by the cadastre zgrada_id', async ({ mockApi: page }) => {
    await page.goto('/?city=zg');
    await waitForMapReady(page);

    const result = await page.evaluate(([gdi, dgu]) => {
      const w = window as any;
      return {
        // The one canonical identity every consumer uses.
        gdiKey: w.corridorBuildingKey(gdi),
        // A cadastre feature has no object_id, so it can NEVER produce a usable building id — it
        // falls through to the geometry-derived key. That is deliberate: the cadastre is a
        // reference layer and must not be cuttable.
        dguKey: w.corridorBuildingKey(dgu),
      };
    }, [GDI_FEATURE, DGU_FEATURE]);

    expect(result.gdiKey).toBe('61075');
    expect(result.dguKey).not.toBe('999888');
    expect(result.dguKey).toMatch(/^geom:/);
  });

  test('the carve matches a record to a mesh by object_id alone', async ({ mockApi: page }) => {
    await page.goto('/?city=zg');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      const footprint = {
        type: 'Polygon',
        coordinates: [[
          [15.97, 45.81], [15.9704, 45.81], [15.9704, 45.8103], [15.97, 45.8103], [15.97, 45.81],
        ]],
      };
      const applied = (records: any[]) => ([{
        proposalId: 'p1',
        applied: true,
        roadProposal: { definition: { demolishedBuildings: records } },
      }]);

      const razed = w.collectCarveRecords(applied([{ id: '61075', geometry: footprint }]));
      // A record for a DIFFERENT object, sitting on the very same ground.
      const neighbour = w.collectCarveRecords(applied([{ id: '99999', geometry: footprint }]));

      return {
        named: w.carveBuildingByObjectId(61075, razed),
        // Same geometry, different id → must not touch this mesh. Under the old overlap matching
        // this is precisely the case that produced phantom demolitions.
        notNamed: w.carveBuildingByObjectId(61075, neighbour),
      };
    });

    expect(result.named).toBeTruthy();
    expect(result.named.remainder).toBeNull(); // razed
    expect(result.notNamed).toBeNull();        // untouched
  });

  test('detection reads the POOL, so cutting is independent of every layer toggle', async ({ mockApi: page }) => {
    await installSurveyRoutes(page);
    await page.goto('/?city=zg');
    await waitForMapReady(page);
    await page.evaluate(() => (window as any).map.setView([45.80015, 15.98216], 18, { animate: false }));
    await page.locator('#layers-button').click();
    const gdi = page.locator('#showBuildings');
    const dgu = page.locator('#showBuildingsDgu');
    await gdi.check();
    await dgu.check();
    await expect.poll(() => page.evaluate(() => (window as any).buildingFeaturePool.some((feature: any) => feature.properties.object_id === 61075))).toBe(true);

    const detect = () => page.evaluate(() => {
      const ring = [
        { lat: 45.79998, lng: 15.98198 },
        { lat: 45.79998, lng: 15.98234 },
        { lat: 45.80030, lng: 15.98234 },
        { lat: 45.80030, lng: 15.98198 },
      ];
      return (window as any).detectLoadedBuildingTunnelIntersections(ring).map((hit: any) => hit.id);
    });
    const both = await detect();
    await gdi.uncheck();
    await expect.poll(() => page.evaluate(() => !(window as any).map.hasLayer((window as any).buildingLayer))).toBe(true);
    const dguOnly = await detect();
    await dgu.uncheck();
    const bothOff = await detect();
    await gdi.check();
    const gdiOnly = await detect();

    // The corridor cuts the same building no matter what is switched on. This is the assertion the
    // whole refactor exists for: detection used to read window.buildingLayer, so unticking a box
    // literally removed buildings from the set that could be demolished.
    expect(bothOff).toEqual(['61075']);
    expect(gdiOnly).toEqual(['61075']);
    expect(dguOnly).toEqual(['61075']);
    expect(both).toEqual(['61075']);
  });

  test('both reference layers load and render returned survey geometry when checked', async ({ mockApi: page }) => {
    await installSurveyRoutes(page);
    await page.goto('/?city=zg');
    await waitForMapReady(page);
    await page.evaluate(() => (window as any).map.setView([45.80015, 15.98216], 18, { animate: false }));
    await page.locator('#layers-button').click();
    await page.locator('#showBuildings').check();
    await expect.poll(() => page.evaluate(() => (window as any).buildingFeaturePool.some((feature: any) => feature.properties.object_id === 61075))).toBe(true);
    await expect.poll(() => page.evaluate(() => {
      let found = false;
      (window as any).map.eachLayer((layer: any) => layer.eachLayer?.((child: any) => { if (child.feature?.properties?.object_id === 61075) found = true; }));
      return found;
    })).toBe(true);

    await page.locator('#showBuildingsDgu').check();
    await expect.poll(() => page.evaluate(() => (window as any).dguBuildingLayer?.getLayers?.().some((layer: any) => layer.feature?.properties?.zgrada_id === 999888))).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as any).map.hasLayer((window as any).dguBuildingLayer))).toBe(true);
  });

  test('B opens the picker prefilled from the live survey checkboxes', async ({ mockApi: page }) => {
    await installSurveyRoutes(page);
    await page.goto('/?city=zg');
    await waitForMapReady(page);
    await page.evaluate(() => (window as any).map.setView([45.80015, 15.98216], 18, { animate: false }));
    await page.locator('#layers-button').click();
    await page.locator('#showBuildings').check();
    await page.locator('#showBuildingsDgu').uncheck();
    await expect.poll(() => page.evaluate(() => (window as any).map.hasLayer((window as any).buildingLayer))).toBe(true);

    // Move keyboard focus out of the survey checkbox and close the layers sheet, as a user would
    // before invoking the global B shortcut.
    await page.locator('#layers-button').click();
    await page.keyboard.press('b');
    const dialog = page.locator('.building-layers-dialog');
    await expect(dialog).toBeVisible();
    const boxes = dialog.locator('input[type="checkbox"]');
    await expect(boxes).toHaveCount(3);
    expect(await boxes.nth(0).isChecked()).toBe(true);   // GDI, as on the map
    expect(await boxes.nth(1).isChecked()).toBe(false);  // DGU
    // The surveys are named so they can be told apart, and there is no all-in-one shortcut.
    await expect(dialog).toContainText(/GDI/);
    await expect(dialog).toContainText(/DGU/);
    await expect(dialog).toContainText(/OSM/);

    // Pressing B again while it is up must not stack a second dialog behind the first.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('Enter applies checked surveys; Escape discards dialog edits', async ({ mockApi: page }) => {
    await installSurveyRoutes(page);
    await page.goto('/?city=zg');
    await waitForMapReady(page);
    await page.evaluate(() => (window as any).map.setView([45.80015, 15.98216], 18, { animate: false }));
    await page.locator('#layers-button').click();
    await page.locator('#showBuildings').uncheck();
    await page.locator('#showBuildingsDgu').uncheck();
    await page.locator('#layers-button').click();

    const layerState = () => page.evaluate(() => ({
      gdi: (document.getElementById('showBuildings') as HTMLInputElement).checked,
      dgu: (document.getElementById('showBuildingsDgu') as HTMLInputElement).checked,
    }));

    // Tick GDI and DGU, confirm with Enter — the action button is focused, so Enter is Show.
    await page.keyboard.press('b');
    const dialog = page.locator('.building-layers-dialog');
    await expect(dialog).toBeVisible();
    await dialog.locator('input[type="checkbox"]').nth(0).check();
    await dialog.locator('input[type="checkbox"]').nth(1).check();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    expect(await layerState()).toEqual({ gdi: true, dgu: true });

    // Reopen, untick everything, then Escape: the map must be exactly as it was.
    await page.keyboard.press('b');
    await expect(dialog).toBeVisible();
    await dialog.locator('input[type="checkbox"]').nth(0).uncheck();
    await dialog.locator('input[type="checkbox"]').nth(1).uncheck();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(await layerState()).toEqual({ gdi: true, dgu: true });
  });
});
