// The Compare tab of Buildings and massing (js/three-compare.js): in the model view the canvas splits
// at a divider, each half drawing one chosen state of the scene (Built today, a design, ...); outside
// the model view the tab only says to open it. Swap trades the sides; unticking ends the split.
import { test, expect } from '../helpers/fixtures';
import { openCity, createBuilding } from '../helpers/runtime';
import { mockBuildingScene } from '../helpers/mocks/building-data';
import { Page } from '@playwright/test';

async function openCompareTab(page: Page) {
  if (!(await page.locator('#planning-views').isVisible())) await page.locator('#planning-views-button').click();
  await expect(page.locator('#planning-views')).toBeVisible();
  await page.locator('#planning-tab-compare').click();
  await expect(page.locator('#planning-tab-compare')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#planning-views-compare')).toBeVisible();
  await expect(page.locator('#planning-views-display')).toBeHidden();
}

// Records the next scissored draws: where each half was cut, and whether the design's own meshes were
// drawn in it (visible through every ancestor).
async function recordPasses(page: Page, designId: string) {
  await page.evaluate(id => {
    const w = window as any;
    const { renderer, scene } = w.getThreeModeInternals();
    const passes: any[] = [];
    w.__comparePasses = passes;
    if (!renderer.__compareSpy) {
      const original = renderer.render.bind(renderer);
      renderer.__compareSpy = true;
      renderer.render = (target: any, camera: any) => {
        if (renderer.getScissorTest() && w.__comparePasses) {
          let mesh: any = null;
          scene.traverse((object: any) => { if (!mesh && object.isMesh && object.userData?.proposalId === w.__compareDesign) mesh = object; });
          let visible = !!mesh;
          for (let object = mesh; object; object = object.parent) visible &&= object.visible !== false;
          const rect = renderer.getScissor(new w.THREE.Vector4());
          w.__comparePasses.push({ x: rect.x, width: rect.z, designDrawn: visible });
        }
        return original(target, camera);
      };
    }
    w.__compareDesign = id;
    w.invalidateThreeView();
  }, designId);
  await expect.poll(() => page.evaluate(() => (window as any).__comparePasses.length), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  return page.evaluate(() => {
    const w = window as any;
    const width = w.getThreeModeInternals().renderer.getSize(new w.THREE.Vector2()).x;
    return { width, passes: w.__comparePasses.slice(0, 2) };
  });
}

test('Compare draws Built today and a design side by side in the model view, swaps and ends', async ({ mockApi: page }) => {
  await mockBuildingScene(page);
  await openCity(page);
  const designId = await createBuilding(page);
  const title = await page.evaluate(id => (window as any).proposalStorage.getProposal(id).title, designId);

  // On the 2D map the tab only points to the model view.
  await page.keyboard.press('Escape');
  await openCompareTab(page);
  const enable = page.locator('#planning-compare-enable');
  await expect(enable).toBeDisabled();
  await expect(page.locator('#planning-compare-left')).toBeDisabled();
  await expect(page.locator('.planning-compare-note')).toHaveText('Open the model view to draw the comparison.');
  await page.locator('#planning-views [data-sheet-close]').click();

  await page.locator('#mode-3d-toggle').click();
  await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(id => {
    let found = false;
    (window as any).getThreeModeInternals?.()?.scene.traverse((object: any) => { if (object.isMesh && object.userData?.proposalId === id) found = true; });
    return found;
  }, designId), { timeout: 20_000 }).toBe(true);

  await openCompareTab(page);
  await expect(page.locator('.planning-compare-note')).toBeHidden();
  await expect(enable).toBeEnabled();
  const left = page.locator('#planning-compare-left');
  const right = page.locator('#planning-compare-right');
  await expect(left.locator('option')).toHaveText(['Built today', 'Permitted massing', 'Proposed (all applied designs)', `Design: ${title}`]);
  await expect(left).toHaveValue('built');
  await right.selectOption(`design:${designId}`);

  const handle = page.locator('#three-container .map-compare__handle');
  await expect(handle).toHaveCount(0);
  await enable.check();
  await expect(handle).toBeVisible();
  await expect(page.locator('#three-container .map-compare__label--before')).toHaveText('Built today');
  await expect(page.locator('#three-container .map-compare__label--after')).toHaveText(`Design: ${title}`);

  // Two passes split at the middle: the design is drawn only in its own (right) half.
  const split = await recordPasses(page, designId);
  const half = Math.round(split.width / 2);
  expect(split.passes).toEqual([
    { x: 0, width: half, designDrawn: false },
    { x: half, width: split.width - half, designDrawn: true },
  ]);

  // Swap trades the sides, labels and halves.
  await page.locator('#planning-compare-swap').click();
  await expect(left).toHaveValue(`design:${designId}`);
  await expect(right).toHaveValue('built');
  await expect(page.locator('#three-container .map-compare__label--before')).toHaveText(`Design: ${title}`);
  await expect(page.locator('#three-container .map-compare__label--after')).toHaveText('Built today');
  const swapped = await recordPasses(page, designId);
  expect(swapped.passes.map((pass: any) => pass.designDrawn)).toEqual([true, false]);

  // Unticking ends the comparison: no divider, and the whole view is drawn in one unscissored pass.
  await enable.uncheck();
  await expect(handle).toHaveCount(0);
  await page.evaluate(() => {
    const w = window as any;
    w.__comparePasses = [];
    w.__unscissoredFrames = 0;
    const { renderer } = w.getThreeModeInternals();
    const spied = renderer.render;
    renderer.render = (target: any, camera: any) => {
      if (!renderer.getScissorTest()) w.__unscissoredFrames++;
      return spied(target, camera);
    };
    w.invalidateThreeView();
  });
  await expect.poll(() => page.evaluate(() => (window as any).__unscissoredFrames), { timeout: 15_000 }).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as any).__comparePasses.length)).toBe(0);
  // The design is visible again in the single pass.
  expect(await page.evaluate(id => {
    let mesh: any = null;
    (window as any).getThreeModeInternals().scene.traverse((object: any) => { if (!mesh && object.isMesh && object.userData?.proposalId === id) mesh = object; });
    let visible = !!mesh;
    for (let object = mesh; object; object = object.parent) visible &&= object.visible !== false;
    return visible;
  }, designId)).toBe(true);
});
