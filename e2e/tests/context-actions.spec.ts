import { test, expect } from '../helpers/fixtures';
import { clickMapPoint, createSpace, openCity, openParcel, proposalState, showProposal, PARCEL_ID } from '../helpers/runtime';
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
    await page.locator('#multiSelectCheckboxInfo').check();
    await page.locator('#parcel-info-panel .close-button').click();
    await clickMapPoint(page, 15.9829, 45.80025);
    await expect.poll(() => page.evaluate(() => [...(window as any).multiParcelSelection.selectedParcels].sort()))
      .toEqual([PARCEL_ID, SECOND_PARCEL_ID].sort());

    await page.locator('#selection-tray [data-command="selection.useAsSite"]').click();
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

  test('the parcel menu and the ground menu are never open together', async ({ mockApi: page }) => {
    await openCity(page);
    await ensureSecondParcel(page);
    const parcelMenu = page.locator('#parcel-menu');
    const groundMenu = page.locator('#ground-menu');
    await clickMapPoint(page, 15.9829, 45.80025);
    await expect(parcelMenu).toBeVisible();
    // Bare ground next to it: the ground menu replaces the parcel menu, which deselects as on Esc.
    await clickMapPoint(page, 15.98255, 45.80025);
    await expect(groundMenu).toBeVisible();
    await expect(parcelMenu).toBeHidden();
    // And back: a parcel click replaces the ground menu. The menu opens over the first parcel, so
    // click the centre of a loaded parcel it leaves uncovered.
    const free = await page.evaluate(() => {
      const w = window as any;
      const menu = document.getElementById('ground-menu')!.getBoundingClientRect();
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
    expect(free, 'a loaded parcel outside the ground menu').toBeTruthy();
    await page.mouse.click(free!.x, free!.y);
    await expect(parcelMenu).toBeVisible();
    await expect(groundMenu).toBeHidden();
  });

  test('bare-ground menu exposes transport actions and real station placement can be cancelled', async ({ mockApi: page }) => {
    await openCity(page);
    await ensureSecondParcel(page);
    // The sample parcels leave a narrow, loaded unsurveyed gap between their boundaries.
    await clickMapPoint(page, 15.98255, 45.80025);
    const menu = page.locator('#ground-menu');
    await expect(menu).toBeVisible();
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
    // from the same bare-ground menu, and its own editor toolbar carries the Cancel.
    await clickMapPoint(page, 15.98255, 45.80025);
    await expect(menu).toBeVisible();
    await menu.locator('[data-command="ground.busStation"]').click();
    const toolbar = page.locator('#station-placement-toolbar');
    await expect(toolbar).toBeVisible();
    await expect(page.locator('#station-placement-status')).toContainText(/bus|station/i);
    await expect.poll(() => page.evaluate(() => (window as any).transitStationPlacementMode)).toBe(true);
    await toolbar.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('#station-placement-status')).toContainText('Station placement cancelled.');
    await expect.poll(() => page.evaluate(() => (window as any).transitStationPlacementMode)).toBe(false);
  });

  test('editing a proposal forks its geometry on the ground beneath it', async ({ mockApi: page }) => {
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

    await expect.poll(() => page.evaluate(sourceId => {
      const w = window as any;
      const source = w.proposalStorage.getProposal(sourceId);
      const sourceTrees = source?.structureProposal?.decorations?.trees || [];
      const fork = w.proposalStorage.getAllProposals().find((proposal: any) =>
        proposal.proposalId !== sourceId
        && proposal.structureProposal?.kind === 'park'
        && (proposal.structureProposal?.decorations?.trees || []).length > sourceTrees.length
      );
      if (!fork) return null;
      return JSON.parse(JSON.stringify(fork));
    }, sourceId), { timeout: 10000 }).toBeTruthy();

    const result = await page.evaluate(({ sourceId, sourceBefore }) => {
      const w = window as any;
      const source = w.proposalStorage.getProposal(sourceId);
      const fork = w.proposalStorage.getAllProposals().find((proposal: any) =>
        proposal.proposalId !== sourceId
        && proposal.structureProposal?.kind === 'park'
        && (proposal.structureProposal?.decorations?.trees || []).length
          > (sourceBefore.structureProposal?.decorations?.trees || []).length
      );
      return { source, fork };
    }, { sourceId, sourceBefore });
    expect(result.fork).toBeTruthy();
    expect(result.fork.cadastreParcelIds).toEqual(sourceBefore.cadastreParcelIds);
    expect(result.fork.site).toEqual(sourceBefore.site);
    expect(result.fork.structureProposal.geometry).toEqual(sourceBefore.structureProposal.geometry);
    expect(result.fork.structureProposal.decorations.trees.length)
      .toBeGreaterThan(sourceBefore.structureProposal?.decorations?.trees?.length || 0);
    expect(result.source.title).toBe(sourceBefore.title);
    expect(result.source.structureProposal).toEqual(sourceBefore.structureProposal);
  });
});
