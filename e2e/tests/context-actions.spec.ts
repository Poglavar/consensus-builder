import { test, expect } from '../helpers/fixtures';
import { clickMapPoint, createSpace, openCity, openParcel, proposalState, showProposal, PARCEL_ID, closeParcel, runSelectionCommand } from '../helpers/runtime';
import { sampleParcels } from '../helpers/mocks/parcel-data';

const SECOND_PARCEL_ID = 'HR-335754-1235';

async function ensureSecondParcel(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async id => {
    const w = window as any;
    await w.CadastralParcelRepository.ensureIds([id]);
  }, SECOND_PARCEL_ID);
  await expect.poll(() => page.evaluate(id => !!(window as any).LiveParcelFabric.get(id), SECOND_PARCEL_ID)).toBe(true);
}

test.describe('Map context actions @features', () => {
  test('multi-parcel selection becomes one saved park site covering both parcels', async ({ mockApi: page }) => {
    // This case exercises the connected multi-parcel authoring path. Keep the app real while the
    // boundary fixture makes the two selected parcel features share an edge.
    await page.route('**/parcels**', route => {
      const request = route.request();
      const url = new URL(request.url());
      if ((request.resourceType() !== 'fetch' && request.resourceType() !== 'xhr')
        || !url.pathname.includes('/parcels') || /\/(ownership|history)$/.test(url.pathname)
        || request.method() !== 'GET') return route.continue();
      const fixture = JSON.parse(JSON.stringify(sampleParcels));
      const adjacent = fixture.features.find((feature: any) => feature.properties.parcelId === SECOND_PARCEL_ID);
      adjacent.geometry.coordinates[0].forEach((coordinate: number[]) => {
        if (coordinate[0] === 15.9826) coordinate[0] = 15.9825;
      });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) });
    });
    await openCity(page);
    await ensureSecondParcel(page);
    const selectedFeatures = await page.evaluate(ids => JSON.parse(JSON.stringify(ids.map(id => (window as any).LiveParcelFabric.get(id)))), [PARCEL_ID, SECOND_PARCEL_ID]);
    await openParcel(page);
    await page.locator('#parcel-manual-selection').click();
    await closeParcel(page);
    await clickMapPoint(page, 15.9829, 45.80025);
    await expect.poll(() => page.evaluate(() => [...(window as any).multiParcelSelection.selectedParcels].sort()))
      .toEqual([PARCEL_ID, SECOND_PARCEL_ID].sort());

    await runSelectionCommand(page, 'selection.useAsSite');
    await expect(page.locator('#site-panel')).toBeVisible();
    await page.locator('[data-site-action="propose"]').click();
    await page.locator('#site-info-panel .parcel-build-btn--park').click();
    await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals()
      .some((p: any) => p.applied && p.structureProposal?.kind === 'park' && p.site))).toBe(true);

    const coversBoth = await page.evaluate(features => {
      const w = window as any;
      const park = w.proposalStorage.getAllProposals().find((p: any) => p.applied && p.structureProposal?.kind === 'park' && p.site);
      return features.every((feature: any) => w.turf.booleanIntersects(park.site, feature));
    }, selectedFeatures);
    expect(coversBoth).toBe(true);
    await expect(page.locator('#site-panel')).toBeHidden();
  });

  test('the click stack shows either the parcel or the bare ground, never both', async ({ mockApi: page }) => {
    await openCity(page);
    await ensureSecondParcel(page);
    const parcelMenu = page.locator('#click-stack .click-stack__section[data-kind="parcels"]');
    const groundMenu = page.locator('#click-stack .click-stack__section[data-kind="ground"]');
    await clickMapPoint(page, 15.9829, 45.80025);
    await expect(parcelMenu).toBeVisible();
    // Bare ground next to it: the stack shows that spot, the ground section instead of the parcel.
    await clickMapPoint(page, 15.98255, 45.80025);
    await expect(groundMenu).toBeVisible();
    await expect(parcelMenu).toHaveCount(0);
    // And back: a parcel click replaces the ground section. Click the centre of a loaded parcel
    // the docked stack leaves uncovered.
    const free = await page.evaluate(() => {
      const w = window as any;
      const menu = document.getElementById('click-stack')!.getBoundingClientRect();
      const box = w.map.getContainer().getBoundingClientRect();
      for (const feature of w.LiveParcelFabric.queryBounds(w.map.getBounds())) {
        const centre = w.turf.centerOfMass(feature).geometry.coordinates;
        const p = w.map.latLngToContainerPoint([centre[1], centre[0]]);
        const x = box.left + p.x, y = box.top + p.y;
        const covered = x >= menu.left - 8 && x <= menu.right + 8 && y >= menu.top - 8 && y <= menu.bottom + 8;
        if (!covered && x > 80 && y > 80 && x < innerWidth - 80 && y < innerHeight - 120) return { x, y };
      }
      return null;
    });
    expect(free, 'a loaded parcel outside the click stack').toBeTruthy();
    await page.mouse.click(free!.x, free!.y);
    await expect(parcelMenu).toBeVisible();
    await expect(groundMenu).toHaveCount(0);
  });

  test('the bare-ground section exposes transport actions and real station placement can be cancelled', async ({ mockApi: page }) => {
    await openCity(page);
    await ensureSecondParcel(page);
    // The sample parcels leave a narrow, loaded unsurveyed gap between their boundaries.
    await clickMapPoint(page, 15.98255, 45.80025);
    const menu = page.locator('#click-stack');
    await expect(menu.locator('.click-stack__section[data-kind="ground"]')).toBeVisible();
    for (const command of ['ground.road', 'ground.track', 'ground.busStation', 'ground.tramStation']) {
      await expect(menu.locator(`[data-command="${command}"]`)).toBeVisible();
    }
    await menu.locator('[data-command="ground.track"]').click();
    await expect(page.locator('#track-speed-confirm-btn')).toBeVisible();
    await page.locator('#track-speed-confirm-btn').click();
    await expect(page.locator('#road-drawing-controls')).toBeVisible();
    await page.locator('#road-info-panel .close-button').click();
    await expect(page.locator('#road-info-panel')).toBeHidden();

    // The Tools sheet's station buttons went with the sheet (fbe3758d); station placement starts
    // from the same bare-ground section, and its own editor toolbar carries the Cancel.
    await clickMapPoint(page, 15.98255, 45.80025);
    await expect(menu.locator('.click-stack__section[data-kind="ground"]')).toBeVisible();
    await menu.locator('[data-command="ground.busStation"]').click();
    const toolbar = page.locator('#station-placement-toolbar');
    await expect(toolbar).toBeVisible();
    await expect(page.locator('#station-placement-status')).toContainText(/bus|station/i);
    await expect.poll(() => page.evaluate(() => (window as any).transitStationPlacementMode)).toBe(true);
    await toolbar.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('#station-placement-status')).toContainText('Station placement cancelled.');
    await expect.poll(() => page.evaluate(() => (window as any).transitStationPlacementMode)).toBe(false);
  });

  test('editing an unpublished proposal saves in place on the ground beneath it', async ({ mockApi: page }) => {
    await openCity(page);
    const sourceId = await createSpace(page, 'park');
    const sourceBefore = await proposalState(page, sourceId);
    await showProposal(page, sourceId);
    const panel = page.locator('#proposal-details-panel');
    await panel.locator('#proposal-details-footer .btn-edit-geometry').click();
    const editor = page.locator('#structure-geometry-editor');
    await expect(editor.locator('.on-map-editor__panel')).toBeVisible();

    // The geometry editor starts from the source design. Pick visible open land inside that
    // footprint: its centroid may already contain a rendered tree, which consumes a map click
    // before the editor can place another one.
    const treeCountBefore = await page.locator('.structure-geometry-icon.is-tree').count();
    const openLand = await page.evaluate(geometry => {
      const w = window as any;
      const feature = { type: 'Feature', properties: {}, geometry };
      const [west, south, east, north] = w.turf.bbox(feature);
      const map = w.map;
      const mapBox = map.getContainer().getBoundingClientRect();
      const panel = document.querySelector('#structure-geometry-editor .on-map-editor__panel');
      const panelBox = panel?.getBoundingClientRect();
      const steps = 20;
      for (let row = 1; row < steps; row++) {
        for (let column = 1; column < steps; column++) {
          const lng = west + (east - west) * column / steps;
          const lat = south + (north - south) * row / steps;
          const point = w.turf.point([lng, lat]);
          if (!w.turf.booleanPointInPolygon(point, feature)) continue;
          const pixel = map.latLngToContainerPoint([lat, lng]);
          const x = mapBox.left + pixel.x;
          const y = mapBox.top + pixel.y;
          if (x < mapBox.left + 12 || x > mapBox.right - 12 || y < mapBox.top + 12 || y > mapBox.bottom - 12) continue;
          if (panelBox && x >= panelBox.left && x <= panelBox.right && y >= panelBox.top && y <= panelBox.bottom) continue;
          const hit = document.elementFromPoint(x, y);
          // Decorations are real Leaflet targets in this editor (markers and draggable
          // geometry). Skip them so the click places a tree instead of selecting or dragging one.
          if (hit?.closest('.leaflet-marker-icon, .structure-geometry-icon, .structure-geometry-draggable, #structure-geometry-editor .on-map-editor__panel')) continue;
          return { lng, lat };
        }
      }
      return null;
    }, sourceBefore.structureProposal.geometry);
    expect(openLand, 'an unobstructed point inside the park footprint').toBeTruthy();
    await editor.locator('[data-tool="tree"]').click();
    await clickMapPoint(page, openLand!.lng, openLand!.lat);
    await expect.poll(() => page.locator('.structure-geometry-icon.is-tree').count()).toBe(treeCountBefore + 1);
    await editor.locator('[data-action="save"]').click();
    await expect(editor).toHaveCount(0);

    // An unpublished record is edited in place (c7ef3630): same id, no second park.
    const treesBefore = sourceBefore.structureProposal?.decorations?.trees?.length || 0;
    await expect.poll(() => page.evaluate(sourceId => (window as any).proposalStorage.getProposal(sourceId)
      ?.structureProposal?.decorations?.trees?.length || 0, sourceId), { timeout: 10000 }).toBeGreaterThan(treesBefore);
    const result = await page.evaluate(sourceId => {
      const w = window as any;
      return {
        saved: JSON.parse(JSON.stringify(w.proposalStorage.getProposal(sourceId))),
        parks: w.proposalStorage.getAllProposals().filter((proposal: any) => proposal.structureProposal?.kind === 'park').length
      };
    }, sourceId);
    expect(result.parks).toBe(1);
    expect(result.saved.cadastreParcelIds).toEqual(sourceBefore.cadastreParcelIds);
    expect(result.saved.site).toEqual(sourceBefore.site);
    expect(result.saved.structureProposal.geometry).toEqual(sourceBefore.structureProposal.geometry);
    expect(result.saved.title).toBe(sourceBefore.title);
  });
});
