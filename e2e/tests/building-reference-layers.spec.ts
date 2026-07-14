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
//   3. B toggles the reference layers instantly, and only explains itself when nothing is chosen

import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';

// A GDI footprint as GET /buildings?bbox=&source=gdi serves it: keyed by object_id.
const GDI_FEATURE = {
  type: 'Feature',
  properties: { object_id: 61075, height_m: 14.2 },
  geometry: {
    type: 'Polygon',
    coordinates: [[
      [15.9700, 45.8100], [15.9704, 45.8100], [15.9704, 45.8103], [15.9700, 45.8103], [15.9700, 45.8100],
    ]],
  },
};

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
        status: 'applied',
        roadProposal: { status: 'applied', definition: { demolishedBuildings: records } },
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
    await page.goto('/?city=zg');
    await waitForMapReady(page);

    const result = await page.evaluate(([gdi]) => {
      const w = window as any;
      // Put one GDI building in the pool — the DATA — and rebuild the display layer from it.
      w.buildingFeaturePool = [gdi];

      const detectedWith = (gdiOn: boolean, dguOn: boolean) => {
        const gdiBox = document.getElementById('showBuildings') as HTMLInputElement;
        const dguBox = document.getElementById('showBuildingsDgu') as HTMLInputElement;
        gdiBox.checked = gdiOn;
        dguBox.checked = dguOn;
        w.rebuildBuildingLayerFromPool();
        // A corridor ring straight through the building.
        const ring = [
          { lat: 45.8099, lng: 15.9698 },
          { lat: 45.8099, lng: 15.9706 },
          { lat: 45.8104, lng: 15.9706 },
          { lat: 45.8104, lng: 15.9698 },
        ];
        return w.detectLoadedBuildingTunnelIntersections(ring).map((hit: any) => hit.id);
      };

      return {
        bothOff: detectedWith(false, false),
        gdiOnly: detectedWith(true, false),
        dguOnly: detectedWith(false, true),
        both: detectedWith(true, true),
        // And the layer really was hidden in the bothOff case — i.e. the toggle does something.
        layerHiddenWhenOff: (() => {
          const gdiBox = document.getElementById('showBuildings') as HTMLInputElement;
          gdiBox.checked = false;
          w.rebuildBuildingLayerFromPool();
          return !w.map.hasLayer(w.buildingLayer);
        })(),
      };
    }, [GDI_FEATURE]);

    // The corridor cuts the same building no matter what is switched on. This is the assertion the
    // whole refactor exists for: detection used to read window.buildingLayer, so unticking a box
    // literally removed buildings from the set that could be demolished.
    expect(result.bothOff).toEqual(['61075']);
    expect(result.gdiOnly).toEqual(['61075']);
    expect(result.dguOnly).toEqual(['61075']);
    expect(result.both).toEqual(['61075']);
    expect(result.layerHiddenWhenOff).toBe(true);
  });

  test('both reference layers can be on at once — that is how you see the surveys disagree', async ({ mockApi: page }) => {
    await page.goto('/?city=zg');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const gdi = document.getElementById('showBuildings') as HTMLInputElement | null;
      const dgu = document.getElementById('showBuildingsDgu') as HTMLInputElement | null;
      if (!gdi || !dgu) return { ok: false };
      gdi.checked = true;
      gdi.dispatchEvent(new Event('change'));
      dgu.checked = true;
      dgu.dispatchEvent(new Event('change'));
      return { ok: true, gdiOn: gdi.checked, dguOn: dgu.checked };
    });

    expect(result.ok).toBe(true);
    expect(result.gdiOn).toBe(true);
    expect(result.dguOn).toBe(true);
  });

  test('B toggles instantly when a layer is on, and only opens the dialog when nothing is chosen', async ({ mockApi: page }) => {
    await page.goto('/?city=zg');
    await waitForMapReady(page);

    const dialogVisible = () => page.locator('.cb-confirm-dialog').isVisible().catch(() => false);

    // Start with GDI on: B must turn it off with NO dialog. B is hammered mid-draw.
    await page.evaluate(() => {
      const gdi = document.getElementById('showBuildings') as HTMLInputElement;
      gdi.checked = true;
      gdi.dispatchEvent(new Event('change'));
    });

    await page.keyboard.press('b');
    expect(await dialogVisible()).toBe(false);
    expect(await page.evaluate(() => (document.getElementById('showBuildings') as HTMLInputElement).checked)).toBe(false);

    // B again restores the SAME choice — still no dialog, because a choice is remembered.
    await page.keyboard.press('b');
    expect(await dialogVisible()).toBe(false);
    expect(await page.evaluate(() => (document.getElementById('showBuildings') as HTMLInputElement).checked)).toBe(true);
  });

  test('B with nothing on and nothing ever chosen explains the two surveys and applies the pick', async ({ mockApi: page }) => {
    await page.goto('/?city=zg');
    await waitForMapReady(page);

    // Both layers off and no remembered choice → the dialog is the ONLY way B behaves slowly.
    await page.evaluate(() => {
      (document.getElementById('showBuildings') as HTMLInputElement).checked = false;
      (document.getElementById('showBuildingsDgu') as HTMLInputElement).checked = false;
    });

    await page.keyboard.press('b');

    const dialog = page.locator('.cb-confirm-dialog');
    await expect(dialog).toBeVisible();
    // It names both surveys so the user can tell them apart.
    await expect(dialog).toContainText(/GDI/);
    await expect(dialog).toContainText(/DGU/);

    // Pick "both" — the dialog must set the sidebar checkboxes.
    await dialog.getByRole('button', { name: /both|oboje|ambos/i }).click();

    const state = await page.evaluate(() => ({
      gdi: (document.getElementById('showBuildings') as HTMLInputElement).checked,
      dgu: (document.getElementById('showBuildingsDgu') as HTMLInputElement).checked,
    }));
    expect(state.gdi).toBe(true);
    expect(state.dgu).toBe(true);
  });
});
