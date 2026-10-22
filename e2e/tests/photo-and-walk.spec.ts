import { test, expect } from '../helpers/fixtures';
import { openCity, createSpace } from '../helpers/runtime';
import { mockPhotoTiles } from '../helpers/mocks/photo-data';
import { mockBuildingScene } from '../helpers/mocks/building-data';
import { openAndClosePopup } from '../helpers/controls';
import { pageIndex } from '../helpers/mocks/shared-server';

test('walk chooses a real 3D ground point, cancels with Escape, and opens the configured walking map', async ({ mockApi: page, context }) => {
  await mockBuildingScene(page);
  await openCity(page);
  const walkUrl = await page.evaluate(() => (window as any).CityConfigManager.getWalkConfig().url);
  await context.route(`${walkUrl}**`, route => route.fulfill({ contentType: 'text/html', body: '<title>Walk handoff fixture</title>' }));
  await page.locator('#mode-3d-toggle').click();
  await expect(page.locator('#three-container canvas')).toBeVisible();
  const walk = page.locator('#mode-walk-toggle');
  await expect(walk).toBeVisible();
  await walk.click();
  await expect(page.locator('#three-container')).toHaveClass(/three-mode-walk-pick/);
  await expect(page.locator('#floating-status-text')).toContainText('Click the ground');
  await page.keyboard.press('Escape');
  await expect(page.locator('#three-container')).not.toHaveClass(/three-mode-walk-pick/);
  await walk.click();
  await openAndClosePopup(page, () => page.locator('#three-container canvas').click(), async destination => {
    await destination.waitForURL(url => url.origin === new URL(walkUrl).origin && url.pathname === new URL(walkUrl).pathname, { waitUntil: 'commit' });
    const url = new URL(destination.url());
    expect(url.searchParams.get('st3d')).toBe('walk');
    expect(Number(url.searchParams.get('lat'))).toBeCloseTo(45.80025, 2);
    expect(Number(url.searchParams.get('lon'))).toBeCloseTo(15.9822, 2);
  });
  await expect(page.locator('#three-container')).not.toHaveClass(/three-mode-walk-pick/);
});

test('walk requires publishing local applied proposals and cancelling preserves the model scene', async ({ mockApi: page }) => {
  await mockBuildingScene(page);
  await openCity(page);
  await createSpace(page, 'park');
  await page.locator('#mode-3d-toggle').click();
  await expect(page.locator('#three-container canvas')).toBeVisible();
  await page.locator('#mode-walk-toggle').click();
  // The walk view loads published designs only: the gate offers to publish the applied park first.
  const gate = page.locator('.share-modal-overlay');
  await expect(gate).toBeVisible();
  await expect(gate.locator('.cb-dialog__title')).toHaveText('Publish before walking');
  await expect(gate.locator('.walk-upload-gate__row')).toHaveCount(1);
  await expect(gate.getByRole('button', { name: 'Publish all', exact: true })).toBeVisible();
  await page.locator('.share-modal .close-circle-btn').click();
  await expect(page.locator('.share-modal-overlay')).toBeHidden();
  await expect(page.locator('#three-container canvas')).toBeVisible();
  expect(await page.evaluate(() => (window as any).proposalStorage.getAllProposals().filter((p: any) => p.applied).length)).toBe(1);
  // Closing the gate published nothing.
  expect(pageIndex(page).requests.filter(request => request.method === 'POST')).toEqual([]);
});

test('Photo view enters the actual tiles renderer and returning to 2D releases its scene', async ({ mockApi: page }) => {
  test.setTimeout(60_000);
  await mockBuildingScene(page);
  const tiles = await mockPhotoTiles(page);
  await openCity(page);
  await page.locator('#mode-realistic-toggle').click();
  await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 15000 });
  await expect.poll(tiles.requests, { timeout: 20000 }).toBeGreaterThan(0);
  await expect(page.locator('body')).toHaveClass(/realistic-mode-active/);
  const meshVisible = () => page.evaluate(() => {
    const mesh = (window as any).getThreeModeInternals().scene.getObjectByName('FixturePhotorealMesh');
    if (!mesh?.isMesh || !mesh.geometry?.attributes?.position?.count) return false;
    let object = mesh;
    while (object) { if (!object.visible) return false; object = object.parent; }
    return true;
  });
  await expect.poll(meshVisible, { timeout: 20000 }).toBe(true);
  await page.locator('#layers-button').click();
  const imagery = page.locator('#aerial-city-visible');
  await expect(imagery).toBeVisible();
  await imagery.uncheck();
  await expect.poll(meshVisible).toBe(false);
  await imagery.check();
  await expect.poll(meshVisible).toBe(true);
  await page.locator('#layers-button').click();
  // Open the generated-scene editor from this real photo-mode session and close it through its
  // visible control; photo rendering remains active after dismissing the dialog.
  await page.locator('#mode-ai-toggle').click();
  const aiScene = page.locator('#ai-scene-overlay');
  await expect(aiScene).toBeVisible();
  await aiScene.locator('.ai-scene-close').click();
  await expect(aiScene).toBeHidden();
  await expect(page.locator('body')).toHaveClass(/realistic-mode-active/);
  await page.locator('#mode-2d-toggle').click();
  await expect(page.locator('body')).not.toHaveClass(/realistic-mode-active/);
  await expect(page.locator('#three-container')).toBeHidden();
  await expect(page.locator('#map')).toBeVisible();
});

test('photo seating diagnostics can be copied from their accessible button', async ({ mockApi: page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(() => sessionStorage.setItem('cbSeatDebug', '1'));
  await mockBuildingScene(page);
  await mockPhotoTiles(page);
  await openCity(page);
  await page.locator('#mode-realistic-toggle').click();
  await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 15000 });
  const diagnostics = page.getByRole('button', { name: 'Copy to clipboard', exact: true });
  await expect(diagnostics).toBeVisible({ timeout: 20000 });
  await expect(diagnostics).toContainText(/seat grounded=.*tiles=/);
  await diagnostics.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('seat grounded=');
});

test('Photo parcel controls show source status, select an immutable parcel from the tiles, and close its card', async ({ mockApi: page }) => {
  test.setTimeout(60_000);
  const tiles = await mockPhotoTiles(page);
  await openCity(page);
  await page.locator('#mode-realistic-toggle').click();
  const canvas = page.locator('#three-container canvas');
  await expect(canvas).toBeVisible({ timeout: 15_000 });
  await expect.poll(tiles.requests, { timeout: 20_000 }).toBeGreaterThan(0);
  await expect(page.locator('body')).toHaveClass(/realistic-mode-active/);

  await page.locator('#layers-button').click();
  const toggle = page.locator('#photo-parcels-visible');
  const status = page.locator('#photo-parcels-status');
  await expect(toggle).toBeVisible();
  await expect(status).toBeVisible({ timeout: 20_000 });
  await expect(status).toHaveText('Source parcels · click the city to inspect');
  await toggle.uncheck();
  await expect(status).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as any).__mapModeState.desired)).toBe('photo');
  await toggle.check();
  await expect(status).toBeVisible();
  await expect(status).toHaveText('Source parcels · click the city to inspect');

  await page.locator('#layers-button').click();
  // Project the known source-parcel centre onto the real photo canvas, then verify the pixel ray
  // intersects the loaded fixture mesh before sending a trusted Playwright click at that point.
  await expect.poll(() => page.evaluate(() => (window as any).PhotorealMode.getLoadDiagnostics().grounded), { timeout: 20_000 }).toBe(true);
  const point = await page.evaluate(() => {
    const w = window as any;
    const internals = w.getThreeModeInternals();
    const mesh = internals.scene.getObjectByName('FixturePhotorealMesh');
    if (!mesh?.isMesh) throw new Error('The real photoreal fixture mesh is missing');
    internals.scene.updateMatrixWorld(true);
    const [x, y] = internals.latLngToXY(45.80025, 15.9822);
    const bounds = new w.THREE.Box3().setFromObject(mesh);
    const verticalRay = new w.THREE.Raycaster(new w.THREE.Vector3(x, y, bounds.max.z + 1000), new w.THREE.Vector3(0, 0, -1));
    const surface = verticalRay.intersectObject(mesh, true)[0];
    if (!surface) throw new Error('The source parcel centre has no fixture photo surface');
    const projected = surface.point.clone().project(internals.camera);
    const rect = internals.renderer.domElement.getBoundingClientRect();
    const pixelX = (projected.x + 1) * 0.5 * rect.width;
    const pixelY = (1 - projected.y) * 0.5 * rect.height;
    const ray = new w.THREE.Raycaster();
    ray.setFromCamera(new w.THREE.Vector2(projected.x, projected.y), internals.camera);
    if (!ray.intersectObject(mesh, true).length) throw new Error('The source parcel centre does not ray-hit the real photo mesh');
    return { x: pixelX, y: pixelY };
  });
  await canvas.click({ position: point });
  const card = page.locator('#photo-parcel-selection');
  await expect(card).toBeVisible();
  await expect(page.locator('#photo-parcel-reference')).toHaveText('HR-335754-1234');
  await page.locator('#layers-button').click();
  await toggle.uncheck();
  await expect(status).toBeHidden();
  await expect(card).toBeHidden();
  await toggle.check();
  await expect(status).toBeVisible();
  await expect(card).toBeVisible();
  await page.locator('#layers-button').click();
  await page.locator('#photo-parcel-close').click();
  await expect(card).toBeHidden();
});

test('Buildings and massing opens the model from photo view and returns through the real 2D mode control', async ({ mockApi: page }) => {
  test.setTimeout(60_000);
  await mockBuildingScene(page);
  const tiles = await mockPhotoTiles(page);
  await openCity(page);
  await page.locator('#mode-realistic-toggle').click();
  await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 15_000 });
  await expect.poll(tiles.requests, { timeout: 20_000 }).toBeGreaterThan(0);
  await expect(page.locator('body')).toHaveClass(/realistic-mode-active/);

  await page.getByRole('button', { name: 'Buildings and massing', exact: true }).click();
  const openModel = page.locator('#planning-open-model');
  await expect(openModel).toBeVisible();
  await expect(openModel).toHaveText('Open 3D model view');
  await openModel.click();
  await expect.poll(() => page.evaluate(() => (window as any).__mapModeState.desired)).toBe('model');
  await expect(page.locator('body')).not.toHaveClass(/realistic-mode-active/);
  await expect(page.locator('body')).toHaveClass(/three-mode-active/);
  await expect(page.locator('#three-container canvas')).toBeVisible();

  await page.locator('#mode-2d-toggle').click();
  await expect.poll(() => page.evaluate(() => (window as any).__mapModeState.desired)).toBe('2d');
  await expect(page.locator('body')).not.toHaveClass(/realistic-mode-active/);
  await expect(page.locator('body')).not.toHaveClass(/three-mode-active/);
  await expect(page.locator('#three-container')).toBeHidden();
  await expect(page.locator('#map')).toBeVisible();
});
