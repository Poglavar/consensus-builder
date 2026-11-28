import { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { openCity, createBuilding } from '../helpers/runtime';
import { openPlanningSection } from '../helpers/layers';
import { mockBuildingScene } from '../helpers/mocks/building-data';

async function enter3D(page: Page) {
  await page.locator('#mode-3d-toggle').click();
  await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => !!(window as any).getThreeModeInternals?.()?.scene)).toBe(true);
}

async function openXray(page: Page) {
  await openPlanningSection(page, 'floor-plans');
  await page.locator('#three-mode-xray').click();
  await expect(page.locator('#planning-views')).toBeHidden();
  await expect(page.locator('#three-xray-toolbar')).toHaveAttribute('aria-label', 'X-ray');
  await page.locator('#three-xray-proposed').click();
  await expect.poll(() => page.evaluate(() => {
    const plans = (window as any).getThreeModeInternals().scene.getObjectByName('FloorPlans');
    return plans?.children.filter((group: any) => group.userData?.proposalId).length || 0;
  }), { timeout: 30_000 }).toBeGreaterThan(0);
}

async function closeSheets(page: Page) {
  for (const close of await page.locator('.map-sheet:visible [data-sheet-close]').all()) {
    await close.focus();
    await close.press('Enter');
  }
  await expect(page.locator('.map-sheet:visible')).toHaveCount(0);
}

// Use a polygon from the rendered floor plan itself, rather than a guessed canvas coordinate.
// Floor plans start hidden whenever they are (re)built, until the next frame's level-of-detail
// pass shows them, so the visible floor is found and projected in one read, polled until it exists.
async function apartmentPoint(page: Page) {
  let point = null as { x: number, y: number } | null;
  await expect.poll(async () => (point = await page.evaluate(() => {
    const w = window as any;
    const { scene, camera, renderer } = w.getThreeModeInternals();
    const visibleFloors = (group: any) => group.children.filter((item: any) => item.visible && item.userData?.cbFloorPlanFloor && item.userData.apartmentRegions?.length);
    const group = scene.getObjectByName('FloorPlans')?.children.find((item: any) => item.userData?.proposalId && visibleFloors(item).length);
    if (!group) return null;
    const floor = visibleFloors(group).at(-1);
    const ring = floor.userData.apartmentRegions[0].polygons[0][0];
    const local = new w.THREE.Vector3(
      ring.reduce((sum: number, point: number[]) => sum + point[0], 0) / ring.length,
      ring.reduce((sum: number, point: number[]) => sum + point[1], 0) / ring.length,
      (floor.userData.apartmentRegions[0].elevationM || 0) + 0.04,
    );
    floor.localToWorld(local);
    const ndc = local.project(camera), rect = renderer.domElement.getBoundingClientRect();
    return { x: rect.left + (ndc.x + 1) * rect.width / 2, y: rect.top + (1 - ndc.y) * rect.height / 2 };
  }))).not.toBeNull();
  return point!;
}

test('a private proposed residential building selects apartments in X-ray without a building outline', async ({ mockApi: page }) => {
  test.setTimeout(90_000);
  await mockBuildingScene(page);
  await openCity(page);
  const designId = await createBuilding(page);
  await enter3D(page);

  // This is the requested ghost-only state: proposed is visible as a ghost and existing is off.
  await page.evaluate(() => (window as any).PlanningViews.configure('proposed', 'ghost'));
  await page.evaluate(() => (window as any).PlanningViews.configure('existing', 'off'));
  await openXray(page);
  await expect(page.locator('#three-xray-proposed')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#three-xray-built')).toHaveAttribute('aria-pressed', 'false');
  await expect(page).toHaveURL(/xray=proposed/);
  await closeSheets(page);
  await page.evaluate(() => {
    const w = window as any;
    const group = w.getThreeModeInternals().scene.getObjectByName('FloorPlans').children.find((g: any) => g.userData.proposalId);
    const [targetLng, targetLat] = group.userData.footprintLatLng;
    w.applyThree3DGeoView({targetLat, targetLng, headingDeg: 0, pitchRad: -1.52, range: 75});
  });
  await expect.poll(() => page.evaluate(() => (window as any).getThreeModeInternals().scene.getObjectByName('FloorPlans').children
    .some((g: any) => g.children.some((f: any) => f.visible && f.userData.apartmentRegions?.length)))).toBe(true);

  const point = await apartmentPoint(page);
  await page.mouse.move(point.x, point.y);
  await page.mouse.click(point.x, point.y);

  const panel = page.locator('.three-apartment-panel');
  await expect(panel).toBeVisible();
  const select = panel.locator('#three-apartment-select');
  await expect.poll(() => select.locator('option').count()).toBeGreaterThan(2); // placeholder + adjacent generated apartments
  await expect(select).toHaveValue(/.+/);

  const selected = await select.inputValue();
  const sceneState = await page.evaluate(() => {
    const scene = (window as any).getThreeModeInternals().scene;
    return { selectedUnit: scene.getObjectsByProperty('isMesh', true)
      .some((object: any) => object.name.startsWith('FloorUnitSelection:')),
      outline: !!scene.getObjectByName('click-stack-focus') };
  });
  expect(sceneState.selectedUnit).toBe(true);
  expect(sceneState.outline).toBe(false);

  // Keyboard adjacent-unit selection must update the same live panel and cutaway level.
  await select.focus();
  // Native type-ahead moves to the next option labelled "Floor".
  await select.press('f');
  await expect.poll(() => select.inputValue()).not.toBe(selected);
  const cutaway = await page.evaluate(() => {
    const plans = (window as any).getThreeModeInternals().scene.getObjectByName('FloorPlans');
    const group = plans.children.find((item: any) => item.userData?.proposalId);
    return group?.userData?.cutawayLevel;
  });
  expect(cutaway).toBe(Number((await select.inputValue()).split('::')[0]));

  // Offer and holder actions were renamed with the property market UI (c582eaa31).
  const actions = panel.getByRole('button', { name: /^(Offer to buy|Put up for sale)$/ });
  await expect(actions).toHaveCount(2);
  for (const action of await actions.all()) await expect(action).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Who holds it, offers', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Copy apartment link' })).toBeDisabled();
  await expect(panel.getByRole('status')).toContainText('Publish this design');
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await panel.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await panel.getByRole('button', { name: 'Close', exact: true }).press('Enter');
  await expect(panel).toBeHidden();
  await page.reload({ waitUntil: 'commit' });
  await expect(page.locator('#three-mode-xray')).toHaveAttribute('aria-pressed', 'true', { timeout: 20_000 });
  await expect(page.locator('#three-xray-proposed')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(id => !!(window as any).proposalStorage?.getProposal(id), designId)).toBe(true);
});

test('X-ray hides the apartments panel while the camera is too far for apartments, says so, and Zoom in brings them back; 2D never shows it', async ({ mockApi: page }) => {
  test.setTimeout(90_000);
  await mockBuildingScene(page);
  await openCity(page);
  await createBuilding(page);
  await enter3D(page);
  await openXray(page);
  await closeSheets(page);
  const lookAt = (range: number) => page.evaluate(r => {
    const w = window as any;
    const group = w.getThreeModeInternals().scene.getObjectByName('FloorPlans').children.find((g: any) => g.userData.proposalId);
    const [targetLng, targetLat] = group.userData.footprintLatLng;
    w.applyThree3DGeoView({ targetLat, targetLng, headingDeg: 0, pitchRad: -1.52, range: r });
    w.invalidateThreeView();
  }, range);
  const note = page.locator('#three-xray-zoom-note');
  const panel = page.locator('.three-apartment-panel');

  // Up close: apartments show, a click chooses one, and there is no zoom note.
  await lookAt(75);
  await expect.poll(() => page.evaluate(() => (window as any).getThreeModeInternals().scene.getObjectByName('FloorPlans').children
    .some((g: any) => g.children.some((f: any) => f.visible && f.userData.apartmentRegions?.length)))).toBe(true);
  const point = await apartmentPoint(page);
  await page.mouse.click(point.x, point.y);
  await expect(panel).toBeVisible();
  await expect(note).toBeHidden();

  // Too far for any storey: the panel goes and the note under the X-ray toolbar says why.
  await lookAt(2500);
  await expect(note).toBeVisible();
  await expect(note).toContainText('Apartments are not visible at this zoom.');
  await expect(panel).toBeHidden();

  // Zoom in brings the camera close enough: the note goes and the chosen building's panel is back.
  await note.getByRole('button', { name: 'Zoom in' }).click();
  await expect(note).toBeHidden();
  await expect(panel).toBeVisible();

  // Leaving the model view takes the panel with it, though X-ray stays on for the next visit.
  await page.locator('#mode-2d-toggle').click();
  await expect(panel).toBeHidden();
  await expect(note).toBeHidden();
});
