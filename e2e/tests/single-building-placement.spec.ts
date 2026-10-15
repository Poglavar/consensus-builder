import { selectNativeOption } from '../helpers/controls';
// Real-pointer coverage for whole-building free placement, its starting-parcel guide, snapping,
// persistence, and the published-source replacement boundary. Geometry reads are observational.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, PARCEL_ID, PARCEL_GEOMETRY, proposalState, showProposal } from '../helpers/runtime';
import { sampleParcels } from '../helpers/mocks/parcel-data';
import type { Page } from '@playwright/test';

const EDITOR = '#single-building-editor';
const DESTINATION_PARCEL_ID = sampleParcels.features[1].properties.parcelId;
const INDEPENDENT_PARCEL_ID = sampleParcels.features[3].properties.parcelId;

async function openSingleEditor(page: Page, cityReady = false, parcelId = PARCEL_ID, multiBuildingDesign = true): Promise<void> {
  if (!cityReady) await openCity(page);
  await page.evaluate(async id => {
    const w = window as any;
    if (!w.LiveParcelFabric.get(id)) await w.CadastralParcelRepository.ensureIds([id]);
  }, parcelId);
  await expect.poll(() => page.evaluate(id => !!(window as any).LiveParcelFabric.get(id), parcelId)).toBe(true);
  await openParcel(page, 'proposals', parcelId);
  await page.locator('#parcel-info-panel .parcel-build-btn--single').click();
  await expect(page.locator(`${EDITOR} .on-map-editor__panel`)).toBeVisible();
  await expect(page.locator('#single-building-confirm')).toBeEnabled();
  const details = page.locator(`${EDITOR} details`);
  if (!(await details.evaluate(node => (node as HTMLDetailsElement).open))) {
    await details.locator('summary').click();
  }
  if (multiBuildingDesign) {
    // Use the editor's duplicate and surroundings controls to make a real two-building design.
    await page.locator('#single-building-add').click();
    await selectNativeOption(page.locator('#single-ground-treatment'), 'green');
  }
}

async function editorDesign(page: Page): Promise<{ buildings: any[]; ground: any | null }> {
  return page.evaluate(() => {
    const w = window as any;
    const layers = Object.values(w.map._layers) as any[];
    const buildings = layers
      .filter(layer => layer._path?.classList?.contains('single-building-fill'))
      .map(layer => JSON.parse(JSON.stringify(layer.feature)))
      .sort((a, b) => String(a.properties?.name).localeCompare(String(b.properties?.name)));
    const ground = layers.find(layer => layer.feature?.geometry
      && String(layer._path?.getAttribute?.('fill') || '').toLowerCase() === '#1b5e20');
    return { buildings, ground: ground ? JSON.parse(JSON.stringify(ground.feature.geometry)) : null };
  });
}

async function activeBuilding(page: Page): Promise<any> {
  return page.evaluate(() => {
    const layer = Object.values((window as any).map._layers)
      .find((item: any) => item._path?.classList?.contains('single-building-fill--active')) as any;
    return layer?.feature ? JSON.parse(JSON.stringify(layer.feature)) : null;
  });
}

async function dragActive(page: Page, dx: number, dy = 0, alt = false): Promise<void> {
  const box = await page.locator('#map-container .single-building-fill--active').boundingBox();
  if (!box) throw new Error('The active building footprint is not visible.');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  if (alt) await page.keyboard.down('Alt');
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
  if (alt) await page.keyboard.up('Alt');
}

async function geometryBounds(page: Page): Promise<{ lng: number; lat: number; west: number; east: number; south: number; north: number }> {
  return page.evaluate(() => {
    const w = window as any;
    const layer = Object.values(w.map._layers).find((item: any) => item._path?.classList?.contains('single-building-fill--active')) as any;
    const geometry = layer?.feature?.geometry;
    if (!geometry) throw new Error('No active building geometry is rendered.');
    const [west, south, east, north] = w.turf.bbox(geometry);
    const center = w.turf.centroid(geometry).geometry.coordinates;
    return { lng: center[0], lat: center[1], west, east, south, north };
  });
}

async function pointerDeltaToEastEdge(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = window as any;
    const layer = Object.values(w.map._layers).find((item: any) => item._path?.classList?.contains('single-building-fill--active')) as any;
    const [west, south, east] = w.turf.bbox(layer.feature.geometry);
    const lat = (south + w.turf.bbox(layer.feature.geometry)[3]) / 2;
    const map = w.map;
    const from = map.latLngToContainerPoint([lat, east]);
    // Six to eight metres inside the original parcel is within the snap radius at the test zoom.
    const target = map.latLngToContainerPoint([lat, 15.9825 - 0.000008]);
    return target.x - from.x;
  });
}

async function finishSingle(page: Page): Promise<void> {
  await page.locator('#single-building-confirm').click();
  await expect(page.locator(EDITOR)).toHaveCount(0, { timeout: 20000 });
}

async function createAppliedSingle(page: Page, parcelId = PARCEL_ID): Promise<string> {
  await openCity(page);
  const before = await page.evaluate(() => (window as any).proposalStorage.getAllProposals()
    .filter((p: any) => p.applied && p.buildingProposal?.typologyType === 'single')
    .map((p: any) => p.proposalId));
  await openSingleEditor(page, true, parcelId);
  await finishSingle(page);
  await expect.poll(() => page.evaluate(previous => (window as any).proposalStorage.getAllProposals()
    .some((p: any) => p.applied && p.buildingProposal?.typologyType === 'single' && !previous.includes(p.proposalId)), before)).toBe(true);
  return page.evaluate(previous => (window as any).proposalStorage.getAllProposals()
    .filter((p: any) => p.applied && p.buildingProposal?.typologyType === 'single')
    .find((p: any) => !previous.includes(p.proposalId)).proposalId, before);
}

async function beginGeometryEdit(page: Page, proposalId: string): Promise<void> {
  await showProposal(page, proposalId);
  await page.locator('#proposal-details-panel .btn-edit-geometry').click();
  await expect(page.locator(`${EDITOR} .on-map-editor__panel`)).toBeVisible();
}

test.describe('Single-building placement and immutable replacement @features', () => {
  test('whole-proposal drag moves both buildings and the ground together; one Undo restores them exactly', async ({ mockApi: page }) => {
    await openSingleEditor(page);
    const before = await editorDesign(page);
    expect(before.buildings).toHaveLength(2);
    expect(before.ground).toBeTruthy();

    await dragActive(page, -190);
    const moved = await editorDesign(page);
    expect(moved.buildings).toHaveLength(2);
    expect(moved.ground).toBeTruthy();

    const shifts = await page.evaluate(({ before, moved }) => {
      const w = window as any;
      const centers = (features: any[]) => features.map(feature => w.turf.centroid(feature).geometry.coordinates);
      const a = centers(before.buildings);
      const b = centers(moved.buildings);
      const boxA = w.turf.bbox(before.ground);
      const boxB = w.turf.bbox(moved.ground);
      return [
        b[0][0] - a[0][0], b[0][1] - a[0][1],
        b[1][0] - a[1][0], b[1][1] - a[1][1],
        boxB[0] - boxA[0], boxB[1] - boxA[1]
      ];
    }, { before, moved });
    expect(shifts[0]).toBeLessThan(-0.0005);
    expect(shifts[2]).toBeCloseTo(shifts[0], 5);
    expect(shifts[4]).toBeCloseTo(shifts[0], 5);
    expect(shifts[3]).toBeCloseTo(shifts[1], 5);
    expect(shifts[5]).toBeCloseTo(shifts[1], 5);

    await page.locator(`${EDITOR} #single-building-undo`).click();
    await expect.poll(() => editorDesign(page)).toEqual(before);
  });

  test('individual building drag leaves its neighbor and ground boundary in place', async ({ mockApi: page }) => {
    await openSingleEditor(page);
    const before = await editorDesign(page);
    const activeBefore = await activeBuilding(page);
    expect(activeBefore).toBeTruthy();
    const neighborBefore = before.buildings.find(feature => feature.properties?.name !== activeBefore.properties?.name);
    expect(neighborBefore).toBeTruthy();
    await page.locator(`${EDITOR} [data-placement="snap"]`).uncheck();
    await page.locator('#single-move-together').uncheck();
    await dragActive(page, 24);
    const after = await editorDesign(page);
    const activeAfter = await activeBuilding(page);

    expect(activeAfter.geometry).not.toEqual(activeBefore.geometry);
    const unchangedNeighbor = after.buildings.find(feature => feature.properties?.name === neighborBefore.properties?.name);
    expect(unchangedNeighbor?.geometry).toEqual(neighborBefore.geometry);
    const changedFootprints = before.buildings.filter(feature => {
      const current = after.buildings.find(item => item.properties?.name === feature.properties?.name);
      return JSON.stringify(current?.geometry) !== JSON.stringify(feature.geometry);
    });
    expect(changedFootprints).toHaveLength(1);
    const beforeBox = await page.evaluate(geometry => (window as any).turf.bbox(geometry), before.ground);
    const afterBox = await page.evaluate(geometry => (window as any).turf.bbox(geometry), after.ground);
    expect(afterBox).toEqual(beforeBox);
  });

  test('parcel Lock rejects an outside drag and refuses to crop a design already outside', async ({ mockApi: page }) => {
    // Begin with the valid in-site footprint only: the lock must be enabled before we
    // deliberately move it outside. The multi-building helper setup can exceed this site.
    await openSingleEditor(page, false, PARCEL_ID, false);
    const lock = page.locator(`${EDITOR} [data-placement="lock"]`);
    const snap = page.locator(`${EDITOR} [data-placement="snap"]`);
    await snap.uncheck();
    const initial = await editorDesign(page);
    expect(initial.buildings).toHaveLength(1);
    expect(initial.ground).toBeNull();
    await lock.check();
    const beforeLockedDrag = await editorDesign(page);
    await dragActive(page, -240);
    // A real drag has intermediate pointer positions. The lock may accept an in-site
    // position before rejecting the next outside candidate; it preserves the full shape.
    const afterLockedDrag = await editorDesign(page);
    const lockedGeometry = await page.evaluate(({ before, after, site }) => {
      const w = window as any;
      const previous = before.buildings[0].geometry;
      const current = after.buildings[0].geometry;
      const [west, south, east, north] = w.turf.bbox(current);
      const [siteWest, siteSouth, siteEast, siteNorth] = w.turf.bbox(site);
      return {
        inside: west >= siteWest - 1e-10 && south >= siteSouth - 1e-10
          && east <= siteEast + 1e-10 && north <= siteNorth + 1e-10,
        areaRatio: w.turf.area(current) / w.turf.area(previous),
        vertices: current.coordinates[0].length,
        previousVertices: previous.coordinates[0].length,
      };
    }, { before: beforeLockedDrag, after: afterLockedDrag, site: PARCEL_GEOMETRY });
    expect(afterLockedDrag.buildings).toHaveLength(1);
    expect(lockedGeometry.inside).toBe(true);
    expect(lockedGeometry.areaRatio).toBeCloseTo(1, 6);
    expect(lockedGeometry.vertices).toBe(lockedGeometry.previousVertices);
    await expect(lock).toBeChecked();

    await lock.uncheck();
    await dragActive(page, -240);
    const outside = await editorDesign(page);
    await expect(page.locator('.on-map-editor__placement-warning')).toBeVisible();
    await lock.click();
    await expect(lock).not.toBeChecked();
    await expect.poll(() => editorDesign(page)).toEqual(outside);
  });

  test('snap toggle and Alt produce distinct, observable footprint positions', async ({ mockApi: page }) => {
    await openSingleEditor(page);
    const snap = page.locator(`${EDITOR} [data-placement="snap"]`);
    const undo = page.locator(`${EDITOR} #single-building-undo`);
    const edgeDelta = await pointerDeltaToEastEdge(page);
    await dragActive(page, edgeDelta);
    let bounds = await geometryBounds(page);
    expect(Math.abs(bounds.east - 15.9825)).toBeLessThan(0.000002);
    await undo.click();

    await snap.uncheck();
    await dragActive(page, edgeDelta);
    bounds = await geometryBounds(page);
    expect(bounds.east).toBeLessThan(15.9825 - 0.000003);
    await undo.click();

    await snap.check();
    await dragActive(page, edgeDelta, 0, true);
    bounds = await geometryBounds(page);
    expect(bounds.east).toBeLessThan(15.9825 - 0.000003);
  });

  test('Done binds the moved site and reload restores the exact buildings and ground', async ({ mockApi: page }) => {
    await openSingleEditor(page);
    const before = await editorDesign(page);
    await page.locator(`${EDITOR} [data-placement="snap"]`).uncheck();
    await dragActive(page, 190);
    const moved = await editorDesign(page);
    expect(moved.buildings.map(feature => feature.geometry)).not.toEqual(before.buildings.map(feature => feature.geometry));
    expect(moved.ground).not.toEqual(before.ground);
    const requestPromise = page.waitForRequest(req => req.method() === 'POST' && new URL(req.url()).pathname.endsWith('/proposals/binding'));
    await finishSingle(page);
    const request = await requestPromise;
    const bindingBody = request.postDataJSON();
    const saved = await page.evaluate(() => (window as any).proposalStorage.getAllProposals()
      .find((p: any) => p.applied && p.buildingProposal?.typologyType === 'single'));
    expect(saved.geometry.buildings).toHaveLength(2);
    expect(saved.geometry.groundSurface.treatment).toBe('green');
    expect(saved.geometry.groundBoundary).toBeTruthy();
    expect(saved.freePlacement).toBe(true);
    expect(saved.binding.source).toMatch(/^server:/);
    expect(['complete', 'partial', 'none']).toContain(saved.binding.coverage);
    expect(bindingBody.site).toEqual(saved.site);
    const boundParcelIds = saved.binding.parcels.map((parcel: any) => parcel.parcelId);
    expect(boundParcelIds.length).toBeGreaterThan(0);
    expect(boundParcelIds).toContain(DESTINATION_PARCEL_ID);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(id => !!(window as any).proposalStorage?.getProposal(id), saved.proposalId);
    const restored = await proposalState(page, saved.proposalId);
    expect(restored.geometry.buildings).toEqual(saved.geometry.buildings);
    expect(restored.geometry.groundSurface).toEqual(saved.geometry.groundSurface);
    expect(restored.geometry.groundBoundary).toEqual(saved.geometry.groundBoundary);
    expect(restored.site).toEqual(saved.site);
  });

  test('failed binding keeps the unsaved design and reopens it for repair', async ({ mockApi: page }) => {
    await openSingleEditor(page);
    await dragActive(page, -190);
    const before = await editorDesign(page);
    const draftId = await page.evaluate(() => (window as any).getActiveProposalDesignDraft().id);
    await page.route('**/proposals/binding', route => route.fulfill({ status: 503, json: { error: 'binding temporarily unavailable' } }));
    await page.locator('#single-building-confirm').click();
    await expect(page.locator(`${EDITOR} .on-map-editor__panel`)).toBeVisible({ timeout: 20000 });
    expect(await page.evaluate(id => !!(window as any).proposalDraftStore.getDraft(id), draftId)).toBe(true);
    const after = await editorDesign(page);
    expect(after.buildings.map(feature => feature.geometry)).toEqual(before.buildings.map(feature => feature.geometry));
    expect(after.ground).toEqual(before.ground);
    expect(await page.evaluate(() => (window as any).proposalStorage.getAllProposals()
      .some((p: any) => p.applied && p.buildingProposal?.typologyType === 'single'))).toBe(false);
  });

  test('a non-overlapping edit of a published source preserves it; a local replacement still supersedes', async ({ mockApi: page }) => {
    const publishedId = await createAppliedSingle(page);
    const publishedBefore = await proposalState(page, publishedId);
    await page.evaluate(async id => {
      const storage = (window as any).proposalStorage;
      const source = storage.getProposal(id);
      source.serverProposalId = '741';
      storage.setProposalLifecycleStatus(id, 'Active');
      storage.save();
    }, publishedId);
    await beginGeometryEdit(page, publishedId);
    await page.locator(`${EDITOR} [data-placement="snap"]`).uncheck();
    const moveTogether = page.locator('#single-move-together');
    if (!(await moveTogether.isChecked())) await moveTogether.check();
    await dragActive(page, -360);
    const moved = await editorDesign(page);
    const overlapAreas = await page.evaluate(({ buildings, ground, sourceBuildings, sourceSite }) => {
      const w = window as any;
      const feature = (value: any) => value?.type === 'Feature' ? value : value?.type ? w.turf.feature(value) : null;
      const overlapArea = (left: any, right: any) => {
        const a = feature(left);
        const b = feature(right);
        if (!a || !b) return 0;
        const intersection = w.turf.intersect(a, b);
        return intersection ? w.turf.area(intersection) : 0;
      };
      const context = w.getActiveProposalDesignDraft?.()?.editorPayload?.context || {};
      const currentSite = context.placement?.site;
      const currentBoundary = context.groundBoundary;
      const currentGreenSurface = context.groundSurface?.polygon || ground;
      return {
        buildingAreas: buildings.map((building: any) => sourceBuildings.map((source: any) => overlapArea(building, source))),
        boundaryArea: overlapArea(currentBoundary, sourceSite),
        placementSiteArea: overlapArea(currentSite, sourceSite),
        greenArea: overlapArea(currentGreenSurface, sourceSite),
        hasBoundary: !!currentBoundary?.geometry,
        hasPlacementSite: !!currentSite,
        hasGreenSurface: !!currentGreenSurface
      };
    }, {
      buildings: moved.buildings,
      ground: moved.ground,
      sourceBuildings: publishedBefore.geometry.buildings,
      sourceSite: publishedBefore.site
    });
    expect(overlapAreas.hasBoundary).toBe(true);
    expect(overlapAreas.hasPlacementSite).toBe(true);
    expect(overlapAreas.hasGreenSurface).toBe(true);
    expect(overlapAreas.buildingAreas.flat().every(area => area < 0.01)).toBe(true);
    expect([overlapAreas.boundaryArea, overlapAreas.placementSiteArea, overlapAreas.greenArea].every(area => area < 0.01)).toBe(true);
    await finishSingle(page);
    await expect.poll(() => page.evaluate(id => (window as any).proposalStorage.getAllProposals()
      .filter((p: any) => p.sourceProposalId === id && p.applied).length, publishedId)).toBe(1);
    const publishedAfter = await proposalState(page, publishedId);
    expect(publishedAfter.applied).toBe(true);
    expect(publishedAfter.geometry).toEqual(publishedBefore.geometry);

    // The published source and its applied fork may reserve the first parcel. Create the local
    // replacement fixture on a separate parcel so this assertion does not depend on reopening it.
    const localId = await createAppliedSingle(page, INDEPENDENT_PARCEL_ID);
    await beginGeometryEdit(page, localId);
    await dragActive(page, -190);
    await finishSingle(page);
    await expect.poll(async () => (await proposalState(page, localId)).applied).toBe(false);
    const localFork = await page.evaluate(id => (window as any).proposalStorage.getAllProposals()
      .find((p: any) => p.sourceProposalId === id && p.applied), localId);
    expect(localFork).toBeTruthy();
  });
});
