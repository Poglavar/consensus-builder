import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { openCity, createSpace, createBuilding, PARCEL_GEOMETRY } from '../helpers/runtime';
import { mockPhotoTiles } from '../helpers/mocks/photo-data';
import { mockBuildingScene } from '../helpers/mocks/building-data';
import { openAndClosePopup, selectNativeOption } from '../helpers/controls';
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
  await expect(page.locator('#aerial-city-visible')).toHaveCount(0);
  await expect(page.locator('#photo-parcels-visible')).toBeVisible();
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

test('Google 3D shares proposed-building layer controls and retains choices in model view', async ({ mockApi: page }) => {
  test.setTimeout(60_000);
  await mockBuildingScene(page);
  const tiles = await mockPhotoTiles(page);
  await openCity(page);
  await createBuilding(page);
  await page.locator('#mode-realistic-toggle').click();
  await expect.poll(tiles.requests, { timeout: 20_000 }).toBeGreaterThan(0);
  await expect(page.locator('body')).toHaveClass(/realistic-mode-active/);
  await page.locator('#layers-button').click();
  await expect(page.locator('#model-layer-controls')).toBeVisible();
  await expect(page.locator('#photo-parcels-visible')).toBeVisible();
  await expect(page.locator('.three-mode-radius-row')).toBeHidden();
  await expect(page.locator('.three-mode-decor-toggles')).toBeHidden();
  for (const label of ['People and traffic', 'Streets and pavement']) {
    const row = page.locator('.three-mode-wide-toggle').filter({ hasText: label });
    await expect(row).toHaveCount(1);
    await expect(row).toBeHidden();
  }
  await expect(page.getByText('Non-buildable plots', { exact: true })).toBeVisible();
  const facade = page.locator('#three-mode-facades');
  await facade.check();
  await selectNativeOption(page.locator('#three-mode-facade-style'), 'brick');
  const uniforms = () => page.evaluate(() => (window as any).getThreeModeInternals().renderer.info.programs
    .map((program: any) => program.getUniforms().map.cbFacadeEnabled?.cache?.[0])
    .filter((enabled: any) => enabled !== undefined));
  await expect.poll(async () => (await uniforms()).includes(1)).toBe(true);
  const xray = page.locator('#three-mode-xray');
  await xray.click();
  await page.locator('#three-mode-suggested-layouts').click();
  const floorPlans = () => page.evaluate(() => (window as any).getThreeModeInternals().scene.getObjectByName('FloorPlans')?.children.length || 0);
  await expect.poll(floorPlans, { timeout: 15_000 }).toBeGreaterThan(0);
  await expect(page.locator('#three-mode-suggested-existing')).toBeHidden();
  await expect(page.locator('#three-mode-floor-cutaway')).toBeVisible();
  await page.screenshot({ path: '/tmp/google-shared-layer-controls.png' });

  await page.locator('#layers-button').click();
  await page.locator('#mode-3d-toggle').click();
  await expect(page.locator('body')).not.toHaveClass(/realistic-mode-active/);
  await page.locator('#layers-button').click();
  await expect(page.locator('.three-mode-radius-row')).toBeVisible();
  await expect(page.locator('#photo-parcels-visible')).toBeHidden();
  await expect(facade).toBeChecked();
  await expect(page.locator('#three-mode-facade-style')).toHaveValue('brick');
  await expect(xray).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#three-mode-suggested-existing')).toBeVisible();
  await expect.poll(floorPlans).toBeGreaterThan(0);
  await xray.click();
  await expect(page.locator('#three-mode-suggested-existing')).toBeHidden();
  await expect.poll(floorPlans).toBe(0);
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

test('Photo clicks use the shared parcel section independently of boundary visibility', async ({ mockApi: page }) => {
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
  const parcelSection = page.locator('#three-click-stack .click-stack__section[data-kind="parcels"]');
  await expect(parcelSection).toHaveClass(/is-selected/);
  await expect(parcelSection).toContainText('HR-335754-1234');
  await expect(page.locator('#photo-parcel-selection')).toHaveCount(0);
  const selectedOutline = () => page.evaluate(() => {
    const w = window as any;
    const focus = w.getThreeModeInternals().scene.getObjectByName('click-stack-focus');
    return focus && { kind: focus.userData.kind,
      yellow: focus.children.find((object: any) => object.userData.selectionStroke === 'yellow')?.material.color.getHex() };
  });
  await expect.poll(selectedOutline).toEqual({ kind: 'parcels', yellow: 0xffdd00 });
  const camera = await page.evaluate(() => (window as any).getThreeModeInternals().camera.position.toArray());
  await page.locator('#layers-button').click();
  await toggle.uncheck();
  await expect(status).toBeHidden();
  await expect(parcelSection).toHaveClass(/is-selected/);
  await page.locator('#layers-button').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#three-click-stack')).toBeHidden();
  await canvas.click({ position: point });
  await expect(parcelSection).toHaveClass(/is-selected/);
  await expect.poll(selectedOutline).toEqual({ kind: 'parcels', yellow: 0xffdd00 });
  const after = await page.evaluate(() => (window as any).getThreeModeInternals().camera.position.toArray());
  after.forEach((coordinate: number, index: number) => expect(coordinate).toBeCloseTo(camera[index], 6));
  await page.keyboard.press('Escape');
  await expect(page.locator('#three-click-stack')).toBeHidden();

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

// Project a known geographic point onto the fixture's actual streamed surface, then click its pixel.
async function photoPixel(page: Page, lat: number, lng: number) {
  return page.evaluate(({ lat, lng }) => {
    const w = window as any, internals = w.getThreeModeInternals();
    const mesh = internals.scene.getObjectByName('FixturePhotorealMesh');
    if (!mesh) throw new Error('The streamed photo fixture is missing');
    internals.scene.updateMatrixWorld(true);
    const [x, y] = internals.latLngToXY(lat, lng);
    const ray = new w.THREE.Raycaster(new w.THREE.Vector3(x, y, 2000), new w.THREE.Vector3(0, 0, -1));
    const hit = ray.intersectObject(mesh, true)[0];
    if (!hit) throw new Error('The requested point has no streamed photo surface');
    const ndc = hit.point.clone().project(internals.camera), rect = internals.renderer.domElement.getBoundingClientRect();
    return { x: (ndc.x + 1) * rect.width / 2, y: (1 - ndc.y) * rect.height / 2 };
  }, { lat, lng });
}

test('Photo design clicks select, cycle sections, collapse and retain the camera like model view', async ({ mockApi: page }) => {
  test.setTimeout(60_000);
  await mockBuildingScene(page);
  await mockPhotoTiles(page);
  await openCity(page);
  const id = await createSpace(page, 'park');
  await page.locator('#mode-realistic-toggle').click();
  await expect.poll(() => page.evaluate(() => (window as any).PhotorealMode?.getLoadDiagnostics().grounded), { timeout: 25_000 }).toBe(true);
  const canvas = page.locator('#three-container canvas');
  const pixel = await photoPixel(page, 45.80025, 15.9822);
  const camera = await page.evaluate(() => (window as any).getThreeModeInternals().camera.position.toArray());
  await canvas.click({ position: pixel });
  const design = page.locator('#three-click-stack .click-stack__section[data-kind="designs"]');
  await expect(design).toHaveClass(/is-selected/);
  await expect.poll(() => page.evaluate(() => (window as any).ProposalSelection.getKey())).toBe(id);
  const focus = () => page.evaluate(() => (window as any).getThreeModeInternals().scene.getObjectByName('click-stack-focus')?.userData);
  await expect.poll(focus).toMatchObject({ kind: 'designs', pattern: 'hatch' });
  await design.locator('.click-stack__row').click();
  await expect(design).toHaveClass(/is-selected/);
  await expect.poll(focus).toMatchObject({ kind: 'designs' });
  await canvas.click({ position: pixel });
  await expect.poll(() => page.evaluate(() => (window as any).ThreeClickStack.expanded())).toBe('designs');
  await canvas.click({ position: pixel });
  await expect(page.locator('#three-click-stack .click-stack__section[data-kind="parcels"]')).toHaveClass(/is-selected/);
  const after = await page.evaluate(() => (window as any).getThreeModeInternals().camera.position.toArray());
  after.forEach((coordinate: number, index: number) => expect(coordinate).toBeCloseTo(camera[index], 6));
  await page.keyboard.press('Escape');
  await expect(page.locator('#three-click-stack')).toBeHidden();
});

test('Photo building clicks open the shared source record and survive a switch to model view', async ({ mockApi: page }) => {
  test.setTimeout(60_000);
  await mockBuildingScene(page);
  await mockPhotoTiles(page);
  const ring = [[15.98245,45.79988],[15.98275,45.79988],[15.98275,45.80010],[15.98245,45.80010],[15.98245,45.79988]];
  const bottom = ring.map(([x,y]) => [x,y,0]), top = ring.map(([x,y]) => [x,y,15]);
  const faces = [top, ...bottom.slice(0,-1).map((a,i) => [a,bottom[i+1],top[i+1],top[i],a])]
    .map(coordinates => ({ type: 'Polygon', coordinates: [coordinates] }));
  await page.route('**/buildings/near', route => route.fulfill({ json: { buildings: [{
    object_id: 202, z_min: 0, z_max: 15, faces, floorModel: { footprint: { type: 'Polygon', coordinates: [ring] } }
  }] } }));
  await openCity(page);
  await page.locator('#mode-realistic-toggle').click();
  await expect.poll(() => page.evaluate(() => (window as any).PhotorealMode?.getLoadDiagnostics().grounded), { timeout: 25_000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).ThreeSceneReady.getState({ requireExisting: false }).existingBuildings)).toBe(1);
  await page.locator('#three-container canvas').click({ position: await photoPixel(page, 45.79998, 15.98259) });
  const built = page.locator('#three-click-stack .click-stack__section[data-kind="built"]');
  await expect(built).toHaveClass(/is-selected/);
  await expect(built.locator('#planning-inspector')).toBeVisible();
  await expect(built).toContainText('202');
  await expect.poll(() => page.evaluate(() => (window as any).getThreeModeInternals().scene.getObjectByName('click-stack-focus')?.userData))
    .toMatchObject({ kind: 'built' });
  await page.locator('#mode-3d-toggle').click();
  await expect(page.locator('body')).not.toHaveClass(/realistic-mode-active/);
  await expect(built.locator('#planning-inspector')).toBeVisible();
  await expect(built).toHaveClass(/is-selected/);
});


test('Photo view keeps permitted massing controls and its shared inspector available', async ({ mockApi: page }) => {
  test.setTimeout(60_000);
  await mockBuildingScene(page);
  await mockPhotoTiles(page);
  const source = { id: 'photo-planning-fixture', city: 'sample', label: 'Planning source',
    default: true, scenario: 'family1', scenarios: ['family1'], parcelStudy: 'direct-dimensions.v1',
    capabilities: { areas: true, volumes: true } };
  const massing = { id: 'photo-permitted', role: 'permitted', proposalId: null, title: 'Permitted building',
    source, site: PARCEL_GEOMETRY, areas: [], volumes: [{ id: 'volume', geometry: PARCEL_GEOMETRY, baseM: 0, topM: 12 }],
    spatialReference: { horizontal: 'OGC:CRS84', vertical: 'relative-ground', unit: 'm' },
    assessment: { meaning: 'partial-envelope', status: 'unresolved' }, metrics: { heightM: 12 }, constraints: [] };
  await page.route('**/planning/**', async route => {
    if (!['xhr', 'fetch'].includes(route.request().resourceType())) return route.fallback();
    const url = new URL(route.request().url());
    const city = url.searchParams.get('city') || source.city;
    const id = await page.evaluate(city => (window as any).CityConfigManager.getCityConfig(city).planning.sourceIds[0], city);
    Object.assign(source, { city, id });
    const catalog = url.pathname.endsWith('/sources');
    return route.fulfill({ json: catalog ? { sources: [source] } : {
      schemaVersion: 'planning-representations.v1', city, sources: [source], items: [massing],
      summaries: [], unavailable: [], coverage: 'source-results', nextCursor: null, omitted: 0
    } });
  });
  await openCity(page);
  await page.locator('#planning-views-button').click();
  const panel = page.locator('#planning-views');
  await panel.locator('[data-planning-setting="permitted"]').selectOption('solid');
  await expect.poll(() => page.evaluate(() => (window as any).PlanningViews.getItems().length)).toBe(1);
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('#mode-realistic-toggle').click();
  await expect.poll(() => page.evaluate(() => (window as any).PhotorealMode?.getLoadDiagnostics().grounded), { timeout: 25_000 }).toBe(true);
  await page.locator('#three-container canvas').click({ position: await photoPixel(page, 45.80025, 15.9822) });
  const section = page.locator('#three-click-stack .click-stack__section[data-kind="permitted"]');
  await expect(section).toHaveClass(/is-selected/);
  await expect(section.locator('#planning-inspector')).toBeVisible();
  await expect(section).toContainText('Permitted building');
  await expect.poll(() => page.evaluate(() => (window as any).getThreeModeInternals().scene.getObjectByName('click-stack-focus')?.userData))
    .toMatchObject({ kind: 'permitted', representation: 'volume' });
  await page.locator('#planning-views-button').click();
  await expect(panel.locator('[data-planning-setting="permittedForm"]')).toBeEnabled();
  await panel.locator('[data-planning-setting="permittedForm"]').selectOption('bound');
  await expect.poll(() => page.evaluate(() => (window as any).PlanningViews.getState().permittedForm)).toBe('bound');
});
