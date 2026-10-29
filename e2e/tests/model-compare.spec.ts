// The Compare tab of Buildings and massing (js/three-compare.js): in the model view the canvas splits
// at a divider, each half drawing one chosen state of the scene (Built today, a design, ...); on the
// 2D map the halves draw their buildings as footprints (js/compare-on-map.js). Swap trades the sides;
// Stop comparing, or the X on the divider, ends the split. Any saved design or plan is a side, applied
// or not: what is not applied is read without applying it.
import { test, expect } from '../helpers/fixtures';
import { openCity, createBuilding } from '../helpers/runtime';
import { mockBuildingScene } from '../helpers/mocks/building-data';
import { Page } from '@playwright/test';

// A Leaflet pane has no box of its own, so whether it draws is its computed display.
const paneDisplay = (page: Page, name: string) => page.evaluate(pane => getComputedStyle((window as any).map.getPane(pane)).display, name);

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

test('Compare draws Built today and a design side by side on the map and in the model view, swaps and ends', async ({ mockApi: page }) => {
  await mockBuildingScene(page);
  await openCity(page);
  const designId = await createBuilding(page);
  const title = await page.evaluate(id => (window as any).proposalStorage.getProposal(id).title, designId);

  // On the 2D map each half draws its side's buildings; the note says so and leads to the model view.
  await page.keyboard.press('Escape');
  await openCompareTab(page);
  const enable = page.locator('#planning-compare-enable');
  const left = page.locator('#planning-compare-left');
  const right = page.locator('#planning-compare-right');
  await expect(enable).toBeEnabled();
  await expect(page.locator('.planning-compare-note .sheet-note')).toHaveText(/^On the map, each side draws its own buildings/);
  await expect(page.locator('#planning-compare-open-model')).toBeVisible();
  await expect(enable).toHaveText('Compare');
  await right.selectOption(`design:${designId}`);
  await enable.click();
  await expect(enable).toHaveAttribute('aria-pressed', 'true');
  await expect(enable).toHaveText('Stop comparing');
  await expect(page.locator('#map .map-compare__handle')).toBeVisible();
  await expect(page.locator('#map')).toHaveClass(/\bmap-comparing\b/);
  await expect(page.locator('#map .map-compare__label--after')).toHaveText(`Design: ${title}`);
  // The design's buildings move from their shared pane into the right half alone, clipped at the divider.
  expect(await paneDisplay(page, 'proposedBuildingsPane')).toBe('none');
  await expect.poll(() => page.locator('.leaflet-compareRight-pane path.map-compare-shape--proposed').count()).toBeGreaterThan(0);
  await expect(page.locator('.leaflet-compareLeft-pane path.map-compare-shape--proposed')).toHaveCount(0);
  const clips = await page.evaluate(() => {
    const w = window as any;
    const pane = (name: string) => w.map.getPane(name).style.clipPath;
    const middle = w.map.containerPointToLayerPoint([w.map.getSize().x / 2, 0]).x;
    return { left: pane('compareLeftPane'), right: pane('compareRightPane'), middle };
  });
  expect(clips.right.startsWith(`polygon(${clips.middle}px`)).toBe(true);
  expect(clips.left).toContain(`${clips.middle}px`);
  await page.locator('#planning-compare-swap').click();
  await expect.poll(() => page.locator('.leaflet-compareLeft-pane path.map-compare-shape--proposed').count()).toBeGreaterThan(0);
  await expect(page.locator('.leaflet-compareRight-pane path.map-compare-shape--proposed')).toHaveCount(0);
  await page.locator('#planning-compare-swap').click();
  // The X at the top of the divider ends the comparison, with the sheet closed too.
  await page.locator('#planning-views [data-sheet-close]').click();
  await page.locator('#map .map-compare__close').click();
  await expect(page.locator('#map .map-compare__handle')).toHaveCount(0);
  await openCompareTab(page);
  await expect(enable).toHaveAttribute('aria-pressed', 'false');
  await expect(enable).toHaveText('Compare');
  await expect(page.locator('#map')).not.toHaveClass(/\bmap-comparing\b/);
  await expect(page.locator('.leaflet-compareRight-pane path')).toHaveCount(0);
  expect(await paneDisplay(page, 'proposedBuildingsPane')).toBe('block');
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
  await expect(left.locator('option')).toHaveText(['Built today', 'Permitted massing', 'Proposed (all applied designs)', `Design: ${title}`]);
  await expect(left).toHaveValue('built');
  await right.selectOption(`design:${designId}`);

  const handle = page.locator('#three-container .map-compare__handle');
  await expect(handle).toHaveCount(0);
  await enable.click();
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

  // Stop comparing ends the comparison: no divider, and the whole view is drawn in one unscissored pass.
  await enable.click();
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

test('a saved plan that is not applied is a side: it is read without applying and its building draws on its half alone', async ({ mockApi: page }) => {
  test.setTimeout(120_000);
  await mockBuildingScene(page);
  await openCity(page);
  const designId = await createBuilding(page);
  const { cid, memberCid } = await page.evaluate(id => {
    const w = window as any;
    const record = w.proposalStorage.getProposal(id);
    const plan = w.PlanComposition.create('Unapplied plan', [record], { city: w.resolveCurrentCityCode(), at: '45.8,15.98,17', mode: '2d', language: 'en' });
    w.PlanWorkspace.save(plan);
    return { cid: plan.cid as string, memberCid: w.DesignRecord.cidOf(record) as string };
  }, designId);
  await page.evaluate(id => (window as any).ProposalManager.unapplyProposal(id), designId);
  await page.keyboard.press('Escape');
  await openCompareTab(page);
  const enable = page.locator('#planning-compare-enable');
  const right = page.locator('#planning-compare-right');
  await expect(right.locator(`option[value="plan:${cid}"]`)).toHaveText('Plan: Unapplied plan');
  await right.selectOption(`plan:${cid}`);
  await enable.click();
  // The plan is read as Plan stats reads it, then its unapplied building draws in the right half alone.
  await expect(page.locator('#map .map-compare__label--after')).toHaveText('Plan: Unapplied plan', { timeout: 45_000 });
  await expect.poll(() => page.locator('.leaflet-compareRight-pane path.map-compare-shape--unapplied').count()).toBeGreaterThan(0);
  await expect(page.locator('.leaflet-compareLeft-pane path.map-compare-shape--unapplied')).toHaveCount(0);
  expect(await page.evaluate(id => (window as any).proposalStorage.getProposal(id).applied === true, designId)).toBe(false);
  await page.locator('#planning-views [data-sheet-close]').click();

  // The model view builds the member's meshes under the plan's CID and draws them in the right pass only.
  await page.locator('#mode-3d-toggle').click();
  await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 20_000 });
  await openCompareTab(page);
  await expect(page.locator('#three-container .map-compare__handle')).toBeVisible();
  await expect(page.locator('#three-container .map-compare__label--after')).toHaveText('Plan: Unapplied plan');
  await expect.poll(() => page.evaluate(id => {
    let found = false;
    (window as any).getThreeModeInternals?.()?.scene.traverse((object: any) => { if (object.isMesh && object.userData?.proposalId === id) found = true; });
    return found;
  }, memberCid), { timeout: 20_000 }).toBe(true);
  const split = await recordPasses(page, memberCid);
  expect(split.passes.map((pass: any) => pass.designDrawn)).toEqual([false, true]);
  await enable.click();
  await expect(page.locator('#three-container .map-compare__handle')).toHaveCount(0);
});

test('a saved design that is not applied is a side of its own, read without applying it', async ({ mockApi: page }) => {
  test.setTimeout(120_000);
  await mockBuildingScene(page);
  await openCity(page);
  const designId = await createBuilding(page);
  const title = await page.evaluate(id => (window as any).proposalStorage.getProposal(id).title, designId);
  await page.evaluate(id => (window as any).ProposalManager.unapplyProposal(id), designId);
  await page.keyboard.press('Escape');
  await openCompareTab(page);
  const enable = page.locator('#planning-compare-enable');
  const right = page.locator('#planning-compare-right');
  // No plan holds it: the design itself is offered, and read as Plan stats reads a one-design plan.
  await expect(right.locator(`option[value="design:${designId}"]`)).toHaveText(`Design: ${title}`);
  await right.selectOption(`design:${designId}`);
  await enable.click();
  await expect(page.locator('#map .map-compare__label--after')).toHaveText(`Design: ${title}`, { timeout: 45_000 });
  await expect.poll(() => page.locator('.leaflet-compareRight-pane path.map-compare-shape--unapplied').count()).toBeGreaterThan(0);
  await expect(page.locator('.leaflet-compareLeft-pane path.map-compare-shape--unapplied')).toHaveCount(0);
  expect(await page.evaluate(id => (window as any).proposalStorage.getProposal(id).applied === true, designId)).toBe(false);
  await enable.click();
  await expect(page.locator('#map .map-compare__handle')).toHaveCount(0);
});
