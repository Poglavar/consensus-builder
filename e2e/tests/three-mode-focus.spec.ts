// Opening a proposal while the 3D model is up (from the Proposals list, a search, the status log or
// a share link): ordinary selection preserves the current camera and scene, the proposal stays
// selected, and no collapsed 2D parcel row is left behind
// (three-focus-plan.js, three-mode.js focusThreeModeOnProposals, layer-render.js).
import { test, expect } from '../helpers/fixtures';
import type { Page } from '@playwright/test';
import { openCity, clickMapPoint, PARCEL_ID, PARCEL_GEOMETRY } from '../helpers/runtime';
import { sampleParcels } from '../helpers/mocks/parcel-data';
import { mockBuildingScene } from '../helpers/mocks/building-data';

const OTHER_ID = sampleParcels.features[2].properties.parcelId;
const OTHER_GEOMETRY = sampleParcels.features[2].geometry as any;

function centreOf(geometry: any): { lat: number; lng: number } {
  const ring: number[][] = geometry.coordinates[0];
  const lngs = ring.map(p => p[0]); const lats = ring.map(p => p[1]);
  return { lat: (Math.min(...lats) + Math.max(...lats)) / 2, lng: (Math.min(...lngs) + Math.max(...lngs)) / 2 };
}

function shifted(geometry: any, dLng: number): any {
  return { type: 'Polygon', coordinates: geometry.coordinates.map((ring: number[][]) => ring.map(p => [p[0] + dLng, p[1]])) };
}

function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (v: number) => v * Math.PI / 180;
  const h = Math.sin(toRad(b.lat - a.lat) / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(toRad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
}

const addProposal = (page: Page, title: string, id: string, geometry: any) => page.evaluate(({ title, id, geometry }) => {
  const w = window as any;
  const before = new Set(w.proposalStorage.getAllProposals().map((p: any) => p.proposalId));
  w.proposalStorage.addProposal({ title, goal: 'park', cadastreParcelIds: [id], geometry, structureProposal: { kind: 'park', geometry }, applied: false });
  return w.proposalStorage.getAllProposals().map((p: any) => p.proposalId).find((k: string) => !before.has(k));
}, { title, id, geometry });

async function enter3DOnTheSampleParcel(page: Page): Promise<void> {
  await clickMapPoint(page, 15.9822, 45.80025);
  await page.locator('#mode-3d-toggle').click();
  await expect(page.locator('#mode-3d-toggle')).not.toHaveClass(/mode-btn-loading/, { timeout: 20_000 });
  await expect(page.locator('#three-container canvas')).toBeVisible();
  await expect(page.locator('body')).toHaveClass(/three-mode-active/);
}

const cameraTarget = (page: Page) => page.evaluate(() => {
  const v = (window as any).getThree3DGeoView();
  return v ? { lat: v.targetLat, lng: v.targetLng } : null;
});

// What the Proposals list, the map search and the status log call when a proposal is chosen.
const chooseProposal = (page: Page, id: string) => page.evaluate(id => (window as any).selectAndHighlightProposal(id, null, true, true), id);

test.describe('Opening a proposal while 3D is up @features', () => {
  test('section changes distinguish hatched ground designs from unfilled parcels and retain collapsed selection', async ({ mockApi: page }) => {
    await mockBuildingScene(page);
    await openCity(page);
    const design = await addProposal(page, 'Garden design', PARCEL_ID, PARCEL_GEOMETRY);
    await enter3DOnTheSampleParcel(page);
    await chooseProposal(page, design);
    const focus = () => page.evaluate(() => {
      const group = (window as any).getThreeModeInternals()?.scene.getObjectByName('click-stack-focus');
      return group ? { ...group.userData, count: group.children.length, hatchCount: group.children.filter((o: any) => o.userData.selectionHatch).length } : null;
    });
    await expect.poll(focus).toMatchObject({ kind: 'designs', id: design, pattern: 'hatch', hatchCount: 1 });
    const stack = page.locator('#three-click-stack');
    await stack.locator('.click-stack__section[data-kind="designs"] .click-stack__row').click();
    await expect.poll(focus).toMatchObject({ kind: 'designs', pattern: 'hatch', hatchCount: 1 });
    await expect(stack.locator('.click-stack__body')).toHaveCount(0);
    await stack.locator('.click-stack__section[data-kind="parcels"] .click-stack__row').click();
    await expect.poll(focus).toMatchObject({ kind: 'parcels', id: PARCEL_ID, pattern: 'outline', hatchCount: 0 });
    expect(await page.evaluate(() => (window as any).ProposalSelection.getKey())).toBeNull();
    await stack.locator('.click-stack__section[data-kind="parcels"] .click-stack__row').click();
    await expect(stack.locator('.click-stack__section[data-kind="parcels"]')).toHaveClass(/is-selected/);
    await expect(stack.locator('.click-stack__body')).toHaveCount(0);
    await expect.poll(focus).toMatchObject({ kind: 'parcels', id: PARCEL_ID, pattern: 'outline', hatchCount: 0 });
    await page.keyboard.press('Escape');
    await expect(stack).toBeHidden();
    await expect.poll(focus).toBeNull();
  });

  test('selects a proposal without moving the camera or opening a 2D parcel row', async ({ mockApi: page }) => {
    await mockBuildingScene(page);
    await openCity(page);
    await page.evaluate(id => (window as any).CadastralParcelRepository.ensureIds([id]), OTHER_ID);
    await expect.poll(() => page.evaluate(id => !!(window as any).LiveParcelFabric.get(id), OTHER_ID)).toBe(true);
    await addProposal(page, 'Here', PARCEL_ID, PARCEL_GEOMETRY);
    const other = await addProposal(page, 'Across the street', OTHER_ID, OTHER_GEOMETRY);
    await enter3DOnTheSampleParcel(page);

    const before = await cameraTarget(page);
    expect(before).not.toBeNull();
    const target = centreOf(OTHER_GEOMETRY);
    expect(distanceM(before!, target)).toBeGreaterThan(25);

    await chooseProposal(page, other);
    expect(await cameraTarget(page)).toEqual(before);
    await expect(page.locator('body')).toHaveClass(/three-mode-active/);
    // Selection leaves both the 3D camera and the underlying 2D map in place.
    expect(await page.evaluate(() => Math.abs((window as any).map.getCenter().lat - 45.80025))).toBeLessThan(0.0001);
    expect(await page.evaluate(() => (window as any).ProposalSelection.getKey())).toBe(other);
    await expect(page.locator('#parcel-info-panel')).toBeHidden();
    await expect(page.locator('#proposal-details-panel')).toBeHidden();
  });

  test('selecting a distant proposal preserves the current scene and camera', async ({ mockApi: page }) => {
    await mockBuildingScene(page);
    await openCity(page);
    await addProposal(page, 'Here', PARCEL_ID, PARCEL_GEOMETRY);
    // About 1.5 km east, on parcels the scene never loaded.
    const farGeometry = shifted(OTHER_GEOMETRY, 0.019);
    const far = await addProposal(page, 'Far away', 'HR-335754-9999', farGeometry);
    await enter3DOnTheSampleParcel(page);
    const originBefore = await page.evaluate(() => (window as any).getThreeModeInternals().originLatLng());

    await chooseProposal(page, far);
    expect(await page.evaluate(() => (window as any).getThreeModeInternals().originLatLng())).toEqual(originBefore);
    await expect(page.locator('body')).toHaveClass(/three-mode-active/);
    await expect(page.locator('#three-container canvas')).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).ProposalSelection.getKey())).toBe(far);
    await expect(page.locator('#parcel-info-panel')).toBeHidden();
  });
});
