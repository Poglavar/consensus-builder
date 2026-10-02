import { test, expect } from '../helpers/fixtures';
import { openCity, createSpace, createBuilding, proposalState } from '../helpers/runtime';
import { mockBuildingScene } from '../helpers/mocks/building-data';
import { Page } from '@playwright/test';

async function enter3D(page: Page) {
  await page.locator('#mode-3d-toggle').click();
  await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 15000 });
  await expect.poll(() => page.evaluate(() => !!(window as any).getThreeModeInternals?.())).toBe(true);
}
async function sceneBuildings(page: Page) {
  return page.evaluate(() => {
    const meshes: any[] = [];
    (window as any).getThreeModeInternals().scene.traverse((o: any) => {
      if (o.userData?.isNearbyBuilding3D) meshes.push({ vertices: o.geometry.attributes.position.count, opacity: o.material.userData?.cbBuildingOpacity ?? o.material.opacity, color: o.material.color.getHex() });
    });
    return meshes;
  });
}

test.describe('3D rendering and controls @features', () => {
  test('3D enters with real building meshes, orbit and zoom work, and 2D returns', async ({ mockApi: page }) => {
    await mockBuildingScene(page);
    await openCity(page);
    await enter3D(page);
    await page.locator('#three-mode-built-display').selectOption('solid');
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
    const slider = page.locator('.three-mode-radius-slider');
    await slider.focus();
    await page.keyboard.press('End');
    await page.keyboard.press('Tab');
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1].buffer_meters).toBeGreaterThan(initial.buffer_meters);
    expect(requests[1].geometry).toEqual(initial.geometry);
    const saved = await slider.inputValue();
    await page.locator('#mode-2d-toggle').click();
    await enter3D(page);
    await expect(slider).toHaveValue(saved);
    await expect(page.locator('.three-mode-radius-value')).toContainText(saved);
  });

  test('Planned modes, massing/build-out, reroll and every facade style affect the actual scene', async ({ mockApi: page }) => {
    await mockBuildingScene(page);
    await openCity(page);
    const id = await createBuilding(page, 'max');
    const source = await proposalState(page, id);
    await enter3D(page);
    await page.locator('#three-mode-built-display').selectOption('off');
    const geometry = () => page.evaluate(() => {
      const meshes: any[] = [];
      (window as any).getThreeModeInternals().scene.traverse((o: any) => {
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
      (window as any).getThreeModeInternals().scene.traverse((o: any) => { if (o.isMesh && o.geometry?.attributes?.position?.count) count++; });
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
  await page.locator('#mode-2d-toggle').click();
  await enter3D(page);
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
  const reset = page.locator('.three-mode-reset-btn');
  await expect(reset).toBeVisible();
  const visibleBuildings = () => page.evaluate(() => {
    let count = 0;
    (window as any).getThreeModeInternals().scene.traverse((o: any) => { if (o.userData?.isNearbyBuilding3D && o.visible) count++; });
    return count;
  });
  const isolated = await visibleBuildings();
  await reset.click();
  await expect(reset).toBeHidden();
  await expect.poll(visibleBuildings).toBeGreaterThan(isolated);
});
