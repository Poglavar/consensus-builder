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
    await page.locator('[data-site-action="palette"]').click();
    await page.locator('#site-panel .parcel-build-btn--park').click();
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

  test('bare-ground menu exposes transport actions and real Tools station placement can be cancelled', async ({ mockApi: page }) => {
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

    await page.locator('#tools-button').click();
    await expect(page.locator('#tools-sheet')).toBeVisible();
    await page.locator('#tools-sheet [data-station-type="bus"]').click();
    await expect(page.locator('#station-placement-status')).toContainText(/bus|station/i);
    await expect.poll(() => page.evaluate(() => (window as any).transitStationPlacementMode)).toBe(true);
    await page.locator('#tools-sheet button[onclick="cancelTransitStationPlacement()"]')
      .click();
    await expect(page.locator('#station-placement-status')).toContainText('Station placement cancelled.');
    await expect.poll(() => page.evaluate(() => (window as any).transitStationPlacementMode)).toBe(false);
  });

  test('fork with changed land keeps the source intact and saves a clone on the selected parcel', async ({ mockApi: page }) => {
    await openCity(page);
    await ensureSecondParcel(page);
    const sourceId = await createSpace(page, 'park');
    const sourceBefore = await proposalState(page, sourceId);
    await showProposal(page, sourceId);
    const expand = page.locator('#proposal-details-panel').getByRole('button', { name: 'Expand', exact: true });
    if (await expand.isVisible()) await expand.click();
    await page.locator('.btn-fork-changed-land').click();
    await expect(page.locator('.land-fork-bar')).toBeVisible();
    // An applied site-backed park opens the fork on its authored site with no seeded parcel
    // selection. Select a different live parcel through the map; this is the supported empty-bar
    // state for changing the land declaration of a site-first proposal.
    const selectedLiveIds = () => page.evaluate(() => (window as any).getCurrentParcelSelectionContext().ids as string[]);
    await expect.poll(selectedLiveIds).toEqual([]);
    await clickMapPoint(page, 15.9829, 45.80025);
    await expect(page.locator('#parcel-menu')).toBeVisible();
    await page.locator('#parcel-menu').getByRole('menuitem', { name: 'Select more', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).multiParcelSelection.isActive)).toBe(true);
    await expect.poll(selectedLiveIds).toContain(SECOND_PARCEL_ID);
    const forkCadastreIds: string[] = await page.evaluate(() => {
      const w = window as any;
      return w.LiveParcelFabric.cadastreIdsForParcelIds(w.getCurrentParcelSelectionContext().ids);
    });
    const selectedTargetFeature = await page.evaluate(id => JSON.parse(JSON.stringify((window as any).LiveParcelFabric.get(id))), SECOND_PARCEL_ID);
    await page.locator('.land-fork-bar [data-land-fork-action="continue"]').click();
    await expect(page.locator('.create-proposal-modal')).toBeVisible();
    await expect(page.locator('.land-fork-notice')).toContainText('Fork of');
    await page.locator('#proposalName').fill('Park moved to adjacent parcel');
    await page.locator('#proposalDescription').fill('A changed-land fork created through the proposal details UI.');
    await page.locator('#createProposalSubmitButton').click();
    await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals()
      .some((proposal: any) => proposal.title === 'Park moved to adjacent parcel'))).toBe(true);

    const result = await page.evaluate(({ sourceId, selectedTargetFeature }) => {
      const w = window as any;
      const proposals = w.proposalStorage.getAllProposals();
      const fork = proposals.find((proposal: any) => proposal.title === 'Park moved to adjacent parcel'
        || proposal.name === 'Park moved to adjacent parcel');
      const source = w.getProposalByIdOrHash(sourceId);
      const targetIntersection = fork?.site ? w.turf.intersect(fork.site, selectedTargetFeature) : null;
      const structureIntersection = fork?.structureProposal?.geometry
        ? w.turf.intersect(fork.structureProposal.geometry, selectedTargetFeature) : null;
      const targetIntersectionArea = targetIntersection ? w.turf.area(targetIntersection) : 0;
      const structureIntersectionArea = structureIntersection ? w.turf.area(structureIntersection) : 0;
      return {
        fork: fork && JSON.parse(JSON.stringify(fork)), source: JSON.parse(JSON.stringify(source)),
        targetIntersectionArea, structureIntersectionArea,
      };
    }, { sourceId, selectedTargetFeature });
    expect(result.fork).toBeTruthy();
    expect(result.fork.sourceProposalId).toBe(sourceId);
    expect(result.fork.replacementOfProposalId).toBe(sourceId);
    expect(result.fork.landFork).toBeTruthy();
    expect(result.fork.cadastreParcelIds).toEqual(forkCadastreIds);
    expect(result.fork.cadastreParcelIds).toContain(SECOND_PARCEL_ID);
    expect(result.fork.cadastreParcelIds).not.toContain(PARCEL_ID);
    expect(result.targetIntersectionArea).toBeGreaterThan(0.25);
    expect(result.structureIntersectionArea).toBeGreaterThan(0.25);
    expect(result.source).toEqual(sourceBefore);
  });
});
