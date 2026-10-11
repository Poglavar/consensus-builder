import { test, expect } from '../helpers/fixtures';
import { openCity, createSpace, createBuilding, proposalState } from '../helpers/runtime';
import { mockBuildingScene } from '../helpers/mocks/building-data';
import { Page } from '@playwright/test';

async function enter3D(page: Page) {
  await page.locator('#mode-3d-toggle').click();
  await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 15000 });
  await expect.poll(() => page.evaluate(() => !!(window as any).getThreeModeInternals?.())).toBe(true);
}
// The model's Built/Planned/facade/scenery controls live in the Layers sheet (fbe3758d).
async function openModelLayers(page: Page) {
  if (!(await page.locator('#model-layer-controls').isVisible())) await page.locator('#layers-button').click();
  await expect(page.locator('#model-layer-controls .three-mode-ui-panel')).toBeVisible();
}
async function closeSheets(page: Page) {
  for (const close of await page.locator('.map-sheet:visible [data-sheet-close]').all()) await close.click();
  await expect(page.locator('.map-sheet:visible')).toHaveCount(0);
}
// The model's load radius lives under Settings > Display (fbe3758d).
async function openModelDisplaySettings(page: Page) {
  if (!(await page.locator('#settings-sheet').isVisible())) await page.locator('#settings-button').click();
  const display = page.locator('#settings-sheet details.layer-actions[data-map-modes="3d"]');
  if (!(await display.evaluate((details: HTMLDetailsElement) => details.open))) await display.locator('> summary').click();
  await expect(page.locator('#model-rendering-settings .three-mode-radius-slider')).toBeVisible();
}
// Display changes hide retained building groups instead of rebuilding them (51152a2e), so only
// meshes visible through their whole ancestor chain are actually drawn.
async function sceneBuildings(page: Page) {
  return page.evaluate(() => {
    const meshes: any[] = [];
    (window as any).getThreeModeInternals().scene.traverseVisible((o: any) => {
      if (o.userData?.isNearbyBuilding3D) meshes.push({ vertices: o.geometry.attributes.position.count, opacity: o.material.userData?.cbBuildingOpacity ?? o.material.opacity, color: o.material.color.getHex() });
    });
    return meshes;
  });
}

test.describe('3D rendering and controls @features', () => {
  test('mode buttons stay lower left and parcel clicks preserve the camera while dimming context', async ({ mockApi: page }) => {
    await mockBuildingScene(page); await openCity(page);
    // The strip sits in the same lower-left place in 2D and 3D; nothing moves when the view changes.
    // (The original-cadastre toggle moved into the 2D Layers sheet in fbe3758d.)
    const modeIds = ['mode-2d-toggle', 'mode-3d-toggle', 'mode-realistic-toggle'];
    const modeBoxes = () => Promise.all(modeIds.map(async id => await page.locator('#' + id).boundingBox()));
    const flat = await modeBoxes();
    await enter3D(page);
    await openModelLayers(page);
    await page.locator('#three-mode-built-display').selectOption('solid');
    await closeSheets(page);
    await expect.poll(async () => (await sceneBuildings(page)).length).toBe(2);
    const originalBuildings = await sceneBuildings(page);
    const perspective = await modeBoxes();
    perspective.forEach((box, i) => {
      expect(box!.x).toBeLessThan(30); expect(box!.y).toBeGreaterThan(page.viewportSize()!.height / 2);
      expect(box!.x).toBe(flat[i]!.x); expect(box!.y).toBe(flat[i]!.y);
    });
    const camera = () => page.evaluate(() => {
      const { camera, controls } = (window as any).getThreeModeInternals();
      return { position: camera.position.toArray(), target: controls.target.toArray(), zoom: camera.zoom };
    });
    const point = await page.evaluate(() => {
      const w = window as any, { scene, camera, renderer } = w.getThreeModeInternals();
      let mesh: any;
      scene.traverse((o: any) => { if (o.isMesh && o.userData?.parcelId === 'HR-335754-1234') mesh = o; });
      if (!mesh) throw new Error('No parcel mesh');
      mesh.geometry.computeBoundingBox();
      const p = mesh.geometry.boundingBox.getCenter(new w.THREE.Vector3());
      mesh.localToWorld(p); p.project(camera);
      const box = renderer.domElement.getBoundingClientRect();
      return { x: box.left + (p.x + 1) * box.width / 2, y: box.top + (1 - p.y) * box.height / 2 };
    });
    const before = await camera();
    await page.mouse.click(point.x, point.y);
    await expect(page.locator('.three-mode-parcel-panel')).toBeVisible();
    expect(await camera()).toEqual(before);
    const buildings = await sceneBuildings(page);
    expect(buildings).toHaveLength(2);
    expect(buildings.map(building => building.color)).not.toEqual(originalBuildings.map(building => building.color));
    expect(await page.evaluate(() => {
      let selected = false;
      (window as any).getThreeModeInternals().scene.traverse((o: any) => {
        if (o.isMesh && o.userData?.parcelId === 'HR-335754-1234' && o.material.color?.getHex() === 0x29c8ff) selected = true;
      });
      return selected;
    })).toBe(true);
    const visible = await page.evaluate(() => {
      let count = 0;
      (window as any).getThreeModeInternals().scene.traverse((o: any) => { if (o.userData?.isNearbyBuilding3D && o.visible && o.parent.visible) count++; });
      return count;
    });
    expect(visible).toBe(2);
    // Isolation is exited through the banner's close button (the panel's Show-all button went in fbe3758d).
    const banner = page.locator('.three-mode-isolation-banner');
    await expect(banner).toBeVisible();
    await banner.locator('.isolation-banner-close').click();
    await expect(banner).toBeHidden();
    expect(await camera()).toEqual(before);
    expect((await sceneBuildings(page)).map(building => building.color)).toEqual(originalBuildings.map(building => building.color));
    await page.screenshot({ path: '/private/tmp/colosseum-3d-parcel-emphasis.png' });
  });
  test('3D enters with real building meshes, orbit and zoom work, and 2D returns', async ({ mockApi: page }) => {
    await mockBuildingScene(page);
    await openCity(page);
    await enter3D(page);
    await openModelLayers(page);
    await page.locator('#three-mode-built-display').selectOption('solid');
    await closeSheets(page);
    await expect.poll(async () => (await sceneBuildings(page)).length).toBe(2);
    expect((await sceneBuildings(page))[0].vertices).toBeGreaterThan(12);
    const camera = () => page.evaluate(() => (window as any).getThreeModeInternals().camera.position.toArray());
    const before = await camera();
    const box = await page.locator('#three-container canvas').boundingBox();
    if (!box) throw new Error('No 3D canvas');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2 + 30, { steps: 8 });
    await page.mouse.up();
    await expect.poll(camera).not.toEqual(before);
    const afterOrbit = await camera();
    await page.mouse.wheel(0, -200);
    await expect.poll(camera).not.toEqual(afterOrbit);
    await page.locator('#mode-2d-toggle').click();
    await expect(page.locator('#three-container')).toBeHidden();
    expect(await page.evaluate(() => (window as any).isThreeModeActive())).toBe(false);
    await expect(page.locator('#map')).toBeVisible();
  });

  test('every Built state renders its correct surviving and demolished building set', async ({ mockApi: page }) => {
    await mockBuildingScene(page);
    await openCity(page);
    await createSpace(page, 'park');
    await enter3D(page);
    await openModelLayers(page);
    const display = page.locator('#three-mode-built-display');
    for (const [state, count] of [['solid', 2], ['ghost', 2], ['surviving', 1], ['removed', 1], ['off', 0]] as const) {
      await display.selectOption(state);
      await expect.poll(async () => (await sceneBuildings(page)).length, { message: state }).toBe(count);
      if (state === 'ghost') {
        const meshes = await sceneBuildings(page);
        expect(meshes.every(m => m.opacity < 1)).toBe(true);
      }
    }
    await display.selectOption('solid');
    await expect.poll(async () => (await sceneBuildings(page)).length).toBe(2);
  });

  test('radius requests a wider snapshot and persists across re-entry', async ({ mockApi: page }) => {
    const requests = await mockBuildingScene(page);
    await openCity(page);
    await enter3D(page);
    await expect.poll(() => requests.length).toBe(1);
    const initial = requests[0];
    await openModelDisplaySettings(page);
    const slider = page.locator('.three-mode-radius-slider');
    await slider.focus();
    await page.keyboard.press('End');
    await page.keyboard.press('Tab');
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1].buffer_meters).toBeGreaterThan(initial.buffer_meters);
    expect(requests[1].geometry).toEqual(initial.geometry);
    const saved = await slider.inputValue();
    await closeSheets(page);
    await page.locator('#mode-2d-toggle').click();
    await enter3D(page);
    await openModelDisplaySettings(page);
    await expect(slider).toHaveValue(saved);
    await expect(page.locator('.three-mode-radius-value')).toContainText(saved);
  });

  test('Planned modes, massing/build-out, reroll and every facade style affect the actual scene', async ({ mockApi: page }) => {
    await mockBuildingScene(page);
    await openCity(page);
    const id = await createBuilding(page, 'max');
    const source = await proposalState(page, id);
    await enter3D(page);
    await openModelLayers(page);
    await page.locator('#three-mode-built-display').selectOption('off');
    const geometry = () => page.evaluate(() => {
      const meshes: any[] = [];
      (window as any).getThreeModeInternals().scene.traverseVisible((o: any) => {
        if (!o.isMesh || o.userData?.isNearbyBuilding3D || !o.userData?.cbFacadeOwned) return;
        const positions = o.geometry.attributes.position.array;
        let hash = 0;
        for (let i = 0; i < positions.length; i++) hash += Math.round(positions[i] * 100) * (i + 1);
        meshes.push({ count: positions.length, hash, opacity: o.material.userData.cbBuildingOpacity ?? o.material.opacity });
      });
      return meshes;
    });
    await page.locator('#three-mode-planned-display').selectOption('solid');
    await expect.poll(async () => (await geometry()).length).toBeGreaterThan(0);
    expect((await geometry()).every(m => m.opacity === 1)).toBe(true);
    await page.locator('#three-mode-planned-display').selectOption('ghost');
    await expect.poll(async () => (await geometry()).every(m => m.opacity < 1)).toBe(true);
    await page.locator('#three-mode-planned-display').selectOption('off');
    await expect.poll(async () => (await geometry()).length).toBe(0);
    await page.locator('#three-mode-planned-display').selectOption('solid');

    const allMeshes = () => page.evaluate(() => {
      let count = 0;
      (window as any).getThreeModeInternals().scene.traverseVisible((o: any) => { if (o.isMesh && o.geometry?.attributes?.position?.count) count++; });
      return count;
    });
    await page.locator('#three-mode-planned-representation').selectOption('massing');
    const massingCount = await allMeshes();
    await page.locator('#three-mode-planned-representation').selectOption('buildout');
    await expect.poll(async () => (await geometry()).length).toBeGreaterThan(0);
    const buildoutCount = await allMeshes();
    const beforeReroll = await geometry();
    // A valid realization can repeat; exercise up to five fresh samples of the height range.
    for (let attempt = 0; attempt < 5; attempt++) {
      await page.locator('.three-mode-reroll-btn').click();
      await expect(page.locator('.three-mode-reroll-btn')).toBeEnabled();
      if (JSON.stringify(await geometry()) !== JSON.stringify(beforeReroll)) break;
    }
    expect(await geometry()).not.toEqual(beforeReroll);
    await page.locator('#three-mode-planned-representation').selectOption('both');
    await expect.poll(allMeshes).toBeGreaterThan(Math.max(massingCount, buildoutCount));
    expect(await proposalState(page, id)).toEqual(source);

    const uniforms = () => page.evaluate(() => {
      return (window as any).getThreeModeInternals().renderer.info.programs.map((program: any) => {
        const map = program.getUniforms().map;
        return { enabled: map.cbFacadeEnabled?.cache?.[0], style: map.cbFacadeStyleOverride?.cache?.[0] };
      }).filter((p: any) => p.enabled !== undefined);
    });
    await page.locator('#three-mode-facades').check();
    await expect.poll(async () => (await uniforms()).some((p: any) => p.enabled === 1)).toBe(true);
    const styles = await page.locator('#three-mode-facade-style option').evaluateAll(options => options.map((o: any) => o.value));
    for (let index = 0; index < styles.length; index++) {
      await page.locator('#three-mode-facade-style').selectOption(styles[index]);
      await expect.poll(async () => (await uniforms()).some((p: any) => p.style === index - 1)).toBe(true);
    }
    await page.locator('#three-mode-facades').uncheck();
    await expect.poll(async () => (await uniforms()).every((p: any) => p.enabled === 0)).toBe(true);
    await expect(page.locator('#three-mode-facade-style')).toBeDisabled();
  });
});

test('3D trees use real instanced geometry, toggle off and restore their saved preference', async ({ mockApi: page }) => {
  await mockBuildingScene(page);
  await page.route('**/decor/layers**', route => route.fulfill({ json: { layers: ['trees'] } }));
  await page.route('**/decor/near', route => route.fulfill({ json: { trees: [[15.9822, 45.8002], [15.9827, 45.8003]] } }));
  await openCity(page);
  await enter3D(page);
  await openModelLayers(page);
  const trees = page.locator('.three-mode-trees-toggle').filter({ hasText: 'Trees' }).locator('input');
  const instances = () => page.evaluate(() => {
    const counts: number[] = [];
    (window as any).getThreeModeInternals().scene.traverse((o: any) => { if (o.isInstancedMesh && o.visible && o.parent.visible && ['5c3d1e', '3a6b35'].includes(o.material.color.getHexString())) counts.push(o.count); });
    return counts;
  });
  await expect(trees).toBeChecked();
  await expect.poll(instances).toEqual([2, 2]);
  await trees.uncheck();
  await expect.poll(instances).toEqual([]);
  await closeSheets(page);
  await page.locator('#mode-2d-toggle').click();
  await enter3D(page);
  await openModelLayers(page);
  await expect(trees).not.toBeChecked();
  await expect.poll(instances).toEqual([]);
  await trees.check();
  await expect.poll(instances).toEqual([2, 2]);
});

test('3D selection isolates a proposal and Show all restores the surrounding scene', async ({ mockApi: page }) => {
  await mockBuildingScene(page);
  await openCity(page);
  await createSpace(page, 'park');
  await enter3D(page);
  await page.locator('#three-container canvas').click();
  // Isolation is announced by a banner whose close button restores the scene (Show-all button removed in fbe3758d).
  const banner = page.locator('.three-mode-isolation-banner');
  const reset = banner.locator('.isolation-banner-close');
  await expect(banner).toBeVisible();
  const visibleBuildings = () => page.evaluate(() => {
    let count = 0;
    (window as any).getThreeModeInternals().scene.traverse((o: any) => { if (o.userData?.isNearbyBuilding3D && o.visible) count++; });
    return count;
  });
  const isolated = await visibleBuildings();
  await reset.click();
  await expect(banner).toBeHidden();
  await expect.poll(visibleBuildings).toBeGreaterThan(isolated);
});
