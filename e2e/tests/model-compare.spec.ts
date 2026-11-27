// The Compare tab of Buildings and massing (js/three-compare.js): in the model view the canvas splits
// at a divider, each half drawing one chosen state of the scene (Built today, a design, ...); on the
// 2D map the halves draw their buildings as footprints (js/compare-on-map.js). Swap trades the sides;
// Stop comparing, or the X on the divider, ends the split. Any saved design or plan is a side, applied
// or not: what is not applied is read without applying it. The stats button at the bottom of the divider
// opens the sides' figures in Compare plans.
import { test, expect } from '../helpers/fixtures';
import { selectNativeOption } from '../helpers/controls';
import { openCity, createBuilding, createSpace, drawCorridor, PARCEL_ID, confirmPublish, chooseProfileName, openOnAnotherDevice } from '../helpers/runtime';
import { pageIndex } from '../helpers/mocks/shared-server';
import { mockBuildingScene } from '../helpers/mocks/building-data';
import { waitForMapReady } from '../helpers/app';
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
// drawn in it (visible through every ancestor). A mesh is the design's when it is picked by it
// (userData.proposalId) or drawn for it (userData.designIds: a road's surfaces, a park's trees).
// `lawn` or `ground` narrows it to the design's park lawn or its building ground.
async function recordPasses(page: Page, designId: string, { lawn = false, ground = false } = {}) {
  await page.evaluate(([id, flag]) => {
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
          const owns = (object: any) => {
            for (let node = object; node; node = node.parent) {
              if (node.userData?.proposalId === w.__compareDesign || node.userData?.designIds?.includes(w.__compareDesign)) return true;
            }
            return false;
          };
          scene.traverse((object: any) => { if (!mesh && object.isMesh && owns(object) && (!w.__compareFlag || object.userData?.[w.__compareFlag])) mesh = object; });
          let visible = !!mesh;
          for (let object = mesh; object; object = object.parent) visible &&= object.visible !== false;
          const rect = renderer.getScissor(new w.THREE.Vector4());
          w.__comparePasses.push({ x: rect.x, width: rect.z, designDrawn: visible });
        }
        return original(target, camera);
      };
    }
    w.__compareDesign = id;
    w.__compareFlag = flag;
    w.invalidateThreeView();
  }, [designId, lawn ? 'isParkGround' : ground ? 'isProposalGround' : null] as const);
  await expect.poll(() => page.evaluate(() => (window as any).__comparePasses.length), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  return page.evaluate(() => {
    const w = window as any;
    const width = w.getThreeModeInternals().renderer.getSize(new w.THREE.Vector2()).x;
    return { width, passes: w.__comparePasses.slice(0, 2) };
  });
}

// A design's title as a pattern: the picker shows it with the time the design was made.
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('Compare draws permitted massing and a design side by side on the map and in the model view, swaps and ends', async ({ mockApi: page }) => {
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
  await page.locator('#planning-tab-display').click();
  await expect(page.locator('#planning-tab-display')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#planning-views-display')).toBeVisible();
  await expect(page.locator('#planning-views-compare')).toBeHidden();
  await page.locator('#planning-tab-compare').click();
  await expect(page.locator('#planning-views-compare')).toBeVisible();
  await selectNativeOption(left, 'permitted');
  await expect(left).toHaveValue('permitted');
  await selectNativeOption(right, `design:${designId}`);
  await expect(right).toHaveValue(`design:${designId}`);
  await enable.click();
  await expect(enable).toHaveAttribute('aria-pressed', 'true');
  await expect(enable).toHaveText('Stop comparing');
  await expect(page.locator('#map .map-compare__handle')).toBeVisible();
  await expect(page.locator('#map')).toHaveClass(/\bmap-comparing\b/);
  await expect(page.locator('#map .map-compare__label--before')).toHaveText('Permitted massing');
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
  await expect(page.locator('#planning-compare-open-model')).toBeVisible();
  await page.locator('#planning-compare-open-model').click();
  await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(id => {
    let found = false;
    (window as any).getThreeModeInternals?.()?.scene.traverse((object: any) => { if (object.isMesh && object.userData?.proposalId === id) found = true; });
    return found;
  }, designId), { timeout: 20_000 }).toBe(true);

  await openCompareTab(page);
  await expect(page.locator('.planning-compare-note')).toBeHidden();
  await expect(enable).toBeEnabled();
  // Grouped: today's states, then the design by its title and the time it was made.
  await expect(left.locator('option')).toHaveText(['Built today', 'Permitted massing', 'Proposed (all applied designs)', new RegExp(`^${escapeRegExp(title)} · .+`)]);
  expect(await left.locator('optgroup').evaluateAll(groups => groups.map(group => (group as HTMLOptGroupElement).label))).toEqual(['Today', 'Designs']);
  await expect(left).toHaveValue('permitted');
  await selectNativeOption(right, 'built');
  await expect(right).toHaveValue('built');
  await selectNativeOption(right, `design:${designId}`);
  await expect(right).toHaveValue(`design:${designId}`);

  const handle = page.locator('#three-container .map-compare__handle');
  await expect(handle).toHaveCount(0);
  await enable.click();
  await expect(handle).toBeVisible();
  await expect(page.locator('#three-container .map-compare__label--before')).toHaveText('Permitted massing');
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
  await expect(right).toHaveValue('permitted');
  await expect(page.locator('#three-container .map-compare__label--before')).toHaveText(`Design: ${title}`);
  await expect(page.locator('#three-container .map-compare__label--after')).toHaveText('Permitted massing');
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
  await page.evaluate(() => {
    const w = window as any, original = w.PlanAnalysis;
    w.PlanAnalysis = { ...original, prepare: (...args: any[]) => {
      w.PlanAnalysis = original;
      return Promise.reject(new Error('Comparison read interrupted'));
    } };
  });
  await page.keyboard.press('Escape');
  await openCompareTab(page);
  const enable = page.locator('#planning-compare-enable');
  const right = page.locator('#planning-compare-right');
  // In the picker the plan sits under Plans, by its title; a plan never published shows no date.
  await expect(right.locator(`optgroup[label="Plans"] option[value="plan:${cid}"]`)).toHaveText('Unapplied plan');
  await selectNativeOption(right, `plan:${cid}`);
  await enable.click();
  const retry = page.getByRole('button', { name: 'Retry', exact: true });
  await expect(page.locator('.planning-compare-status')).toContainText('Comparison read interrupted');
  await retry.click();
  await expect(retry).toHaveCount(0);
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
  await page.locator('#three-container').getByRole('button', { name: 'Stop comparing', exact: true }).click();
  await expect(page.locator('#three-container .map-compare__handle')).toHaveCount(0);
  await expect(enable).toHaveAttribute('aria-pressed', 'false');
});

test('an applied road in a plan draws on the plan\'s side, its surfaces and all, and not on Built today', async ({ mockApi: page }) => {
  test.setTimeout(120_000);
  await mockBuildingScene(page);
  await openCity(page);
  const roadId = await drawCorridor(page, 'road');
  const cid = await page.evaluate(id => {
    const w = window as any;
    const plan = w.PlanComposition.create('Streets plan', [w.proposalStorage.getProposal(id)], { city: w.resolveCurrentCityCode(), at: '45.8,15.98,17', mode: '2d', language: 'en' });
    w.PlanWorkspace.save(plan);
    return plan.cid as string;
  }, roadId);
  await page.keyboard.press('Escape');
  await page.locator('#mode-3d-toggle').click();
  await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 20_000 });
  // Every surface the road draws (lanes, markings, pavements, junctions) is marked as the road's.
  await expect.poll(() => page.evaluate(id => {
    let strips = 0, unmarked = 0;
    (window as any).getThreeModeInternals?.()?.scene.traverse((object: any) => {
      if (!object.isMesh || !object.userData?.isCorridorStrip) return;
      strips += 1;
      if (!object.userData.designIds?.includes(id)) unmarked += 1;
    });
    return strips > 0 && unmarked === 0;
  }, roadId), { timeout: 20_000 }).toBe(true);
  await openCompareTab(page);
  await selectNativeOption(page.locator('#planning-compare-left'), 'built');
  await selectNativeOption(page.locator('#planning-compare-right'), `plan:${cid}`);
  await page.locator('#planning-compare-enable').click();
  await expect(page.locator('#three-container .map-compare__label--after')).toHaveText('Plan: Streets plan', { timeout: 45_000 });
  const split = await recordPasses(page, roadId);
  expect(split.passes.map((pass: any) => pass.designDrawn)).toEqual([false, true]);
});

test('a park in a plan that is not applied draws on the plan\'s side as an applied park does, its trees and all', async ({ mockApi: page }) => {
  test.setTimeout(120_000);
  await mockBuildingScene(page);
  await openCity(page);
  const parkId = await createSpace(page, 'park');
  const { cid, memberCid, trees } = await page.evaluate(id => {
    const w = window as any;
    const record = w.proposalStorage.getProposal(id);
    const plan = w.PlanComposition.create('Park plan', [record], { city: w.resolveCurrentCityCode(), at: '45.8,15.98,17', mode: '2d', language: 'en' });
    w.PlanWorkspace.save(plan);
    return { cid: plan.cid as string, memberCid: w.DesignRecord.cidOf(record) as string,
      trees: (record.structureProposal.decorationDesign || record.structureProposal.decorations)?.trees?.length || 0 };
  }, parkId);
  expect(trees).toBeGreaterThan(0);
  await page.evaluate(id => (window as any).ProposalManager.unapplyProposal(id), parkId);
  await page.keyboard.press('Escape');
  await page.locator('#mode-3d-toggle').click();
  await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 20_000 });
  await openCompareTab(page);
  await selectNativeOption(page.locator('#planning-compare-left'), 'built');
  await selectNativeOption(page.locator('#planning-compare-right'), `plan:${cid}`);
  await page.locator('#planning-compare-enable').click();
  await expect(page.locator('#three-container .map-compare__label--after')).toHaveText('Plan: Park plan', { timeout: 45_000 });
  // The plan's side draws the park's own trees, marked as the member's, not a flat plate alone.
  await expect.poll(() => page.evaluate(id => {
    let trees = 0;
    (window as any).getThreeModeInternals?.()?.scene.getObjectByName('CompareUnapplied')?.traverse((object: any) => {
      if (object.userData?.decorationKind !== 'tree') return;
      for (let node = object; node; node = node.parent) if (node.userData?.designIds?.includes(id)) { trees += 1; return; }
    });
    return trees;
  }, memberCid), { timeout: 20_000 }).toBeGreaterThan(0);
  const split = await recordPasses(page, memberCid);
  expect(split.passes.map((pass: any) => pass.designDrawn)).toEqual([false, true]);
});

test('an applied park in a plan keeps its lawn on the plan\'s side whatever park was drawn first', async ({ mockApi: page }) => {
  test.setTimeout(120_000);
  await mockBuildingScene(page);
  await openCity(page);
  // The park outside the plan is drawn first: its lawn leads the park ground.
  await createSpace(page, 'park', 'HR-335754-1235');
  await createSpace(page, 'park', PARCEL_ID);
  const { cid, inPlan } = await page.evaluate(parcelId => {
    const w = window as any;
    const record = w.proposalStorage.getAllProposals().find((p: any) => p.structureProposal?.kind === 'park' && p.cadastreParcelIds?.includes(parcelId));
    const plan = w.PlanComposition.create('One park', [record], { city: w.resolveCurrentCityCode(), at: '45.8,15.98,17', mode: '2d', language: 'en' });
    w.PlanWorkspace.save(plan);
    return { cid: plan.cid as string, inPlan: String(record.proposalId) };
  }, PARCEL_ID);
  await page.keyboard.press('Escape');
  await page.locator('#mode-3d-toggle').click();
  await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 20_000 });
  await openCompareTab(page);
  await selectNativeOption(page.locator('#planning-compare-left'), 'built');
  await selectNativeOption(page.locator('#planning-compare-right'), `plan:${cid}`);
  await page.locator('#planning-compare-enable').click();
  await expect(page.locator('#three-container .map-compare__label--after')).toHaveText('Plan: One park', { timeout: 45_000 });
  const split = await recordPasses(page, inPlan, { lawn: true });
  expect(split.passes.map((pass: any) => pass.designDrawn)).toEqual([false, true]);
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
  await expect(right.locator(`optgroup[label="Designs"] option[value="design:${designId}"]`)).toHaveText(new RegExp(`^${escapeRegExp(title)} · .+`));
  await selectNativeOption(right, `design:${designId}`);
  await enable.click();
  await expect(page.locator('#map .map-compare__label--after')).toHaveText(`Design: ${title}`, { timeout: 45_000 });
  await expect.poll(() => page.locator('.leaflet-compareRight-pane path.map-compare-shape--unapplied').count()).toBeGreaterThan(0);
  await expect(page.locator('.leaflet-compareLeft-pane path.map-compare-shape--unapplied')).toHaveCount(0);
  expect(await page.evaluate(id => (window as any).proposalStorage.getProposal(id).applied === true, designId)).toBe(false);
  await enable.click();
  await expect(page.locator('#map .map-compare__handle')).toHaveCount(0);
});

test('an applied design\'s ground draws on its own side alone, on the map and in the model view', async ({ mockApi: page }) => {
  test.setTimeout(120_000);
  await mockBuildingScene(page);
  await openCity(page);
  const designId = await createBuilding(page);
  await expect.poll(() => page.evaluate(() => (window as any).buildingGroundsDrawn().map((ground: any) => ground.designId))).toEqual([designId]);
  await page.keyboard.press('Escape');
  await openCompareTab(page);
  const enable = page.locator('#planning-compare-enable');
  await selectNativeOption(page.locator('#planning-compare-left'), 'built');
  await selectNativeOption(page.locator('#planning-compare-right'), `design:${designId}`);
  await enable.click();
  await expect(page.locator('#map')).toHaveClass(/\bmap-comparing\b/);
  // The shared ground is hidden and drawn again in the design's (right) half alone.
  const ground = () => page.evaluate(() => {
    const leaves: any[] = [];
    const walk = (layer: any) => (layer.eachLayer ? layer.eachLayer(walk) : leaves.push(layer));
    (window as any).buildingGroundsDrawn().forEach((drawn: any) => walk(drawn.layer));
    return { shared: leaves.length, hidden: leaves.filter(leaf => leaf.getElement?.()?.classList.contains('map-compare-hidden')).length };
  });
  await expect.poll(async () => (await ground()).shared).toBeGreaterThan(0);
  await expect.poll(async () => { const { shared, hidden } = await ground(); return shared === hidden; }).toBe(true);
  await expect.poll(() => page.locator('.leaflet-compareRight-pane path:not(.map-compare-shape)').count()).toBeGreaterThan(0);
  await expect(page.locator('.leaflet-compareLeft-pane path:not(.map-compare-shape)')).toHaveCount(0);

  await page.locator('#planning-compare-open-model').click();
  await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(id => {
    let found = false;
    (window as any).getThreeModeInternals?.()?.scene.traverse((object: any) => {
      if (object.isMesh && object.userData?.isProposalGround && object.userData?.designIds?.includes(id)) found = true;
    });
    return found;
  }, designId), { timeout: 20_000 }).toBe(true);
  const split = await recordPasses(page, designId, { ground: true });
  expect(split.passes.map((pass: any) => pass.designDrawn)).toEqual([false, true]);
});

test('Copy link copies a comparison of what is on the server, publishes a design side first, and the link opens it on another device', async ({ mockApi: page, browser, baseURL }) => {
  test.setTimeout(180_000);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await mockBuildingScene(page);
  await openCity(page);
  const designId = await createBuilding(page);
  const title = await page.evaluate(id => (window as any).proposalStorage.getProposal(id).title, designId);
  const index = pageIndex(page);
  await page.keyboard.press('Escape');
  await openCompareTab(page);
  const copy = page.locator('#planning-compare-copy-link');
  const note = page.locator('#planning-compare-link-note');
  await selectNativeOption(page.locator('#planning-compare-left'), 'built');
  await selectNativeOption(page.locator('#planning-compare-right'), 'permitted');
  await expect(copy).toHaveText('Copy link');
  await expect(note).toBeHidden();
  await copy.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('compare=built%2Cpermitted');

  // A design only in this browser: Copy link publishes it first, after saying what that means. A
  // guest names a profile on the way, and nothing leaves the device until then.
  await selectNativeOption(page.locator('#planning-compare-right'), `design:${designId}`);
  await expect(copy).toHaveText('Publish and copy link');
  await expect(copy).toBeEnabled();
  await expect(note).toBeHidden();
  await copy.click();
  await confirmPublish(page);
  await chooseProfileName(page, 'Compare author');
  expect(index.requests.filter(row => row.method === 'POST' && row.path === '/designs')).toHaveLength(0);
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await copy.click();
  await confirmPublish(page);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 30_000 }).toMatch(/compare=built%2Cdesign-bafkrei[a-z2-7]{52}/);
  expect(index.requests.filter(row => row.method === 'POST' && row.path === '/designs')).toHaveLength(1);
  await expect(copy).toHaveText('Copy link');
  const link = new URL(await page.evaluate(() => navigator.clipboard.readText()));

  // Another device reads the published design from the server and opens the same comparison.
  const receiver = await openOnAnotherDevice(browser, `${link.pathname}${link.search}`, index, baseURL);
  try {
    await expect(receiver.page.locator('#map .map-compare__label--after')).toHaveText(`Design: ${title}`, { timeout: 45_000 });
    // On the 2D map applied roads and parks are shared, so the today side names only its buildings.
    await expect(receiver.page.locator('#map .map-compare__label--before')).toHaveText('Buildings today · roads and parks shared');
    // A link naming a plan that was never published says so instead of opening half a comparison.
    await receiver.page.goto(`/?city=zg&reduceMotion=1&compare=built%2Cbafkrei${'c'.repeat(52)}`, { waitUntil: 'domcontentloaded' });
    await waitForMapReady(receiver.page);
    await expect(receiver.page.getByText('This comparison link names a plan that has not been published', { exact: false })).toBeVisible({ timeout: 30_000 });
    await expect(receiver.page.locator('#map .map-compare__handle')).toHaveCount(0);
  } finally {
    await receiver.context.close();
  }
});

test('a comparison in the address opens with its two sides, and the address follows the comparison', async ({ mockApi: page }) => {
  test.setTimeout(120_000);
  await mockBuildingScene(page);
  await openCity(page);
  const designId = await createBuilding(page);
  const cid = await page.evaluate(id => {
    const w = window as any;
    const plan = w.PlanComposition.create('Shared plan', [w.proposalStorage.getProposal(id)], { city: w.resolveCurrentCityCode(), at: '45.8,15.98,17', mode: '2d', language: 'en' });
    w.PlanWorkspace.save(plan);
    return plan.cid as string;
  }, designId);
  // A link naming Built today and a saved plan by its CID opens the Compare tab with them as the sides.
  await page.goto(`/?city=zg&reduceMotion=1&at=45.80025,15.9822,18&compare=built,${cid}`, { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  await expect(page.locator('#planning-views-compare')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#planning-compare-left')).toHaveValue('built');
  await expect(page.locator('#planning-compare-right')).toHaveValue(`plan:${cid}`);
  await expect(page.locator('#planning-compare-enable')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#map .map-compare__label--before')).toHaveText('Buildings today · roads and parks shared');
  await expect(page.locator('#map .map-compare__label--after')).toHaveText('Plan: Shared plan', { timeout: 45_000 });
  const compareParam = () => page.evaluate(() => new URL(location.href).searchParams.get('compare'));
  expect(await compareParam()).toBe(`built,${cid}`);
  // Swap and Stop comparing rewrite the address; a design held only in this browser has no shareable name.
  await page.locator('#planning-compare-swap').click();
  expect(await compareParam()).toBe(`${cid},built`);
  await selectNativeOption(page.locator('#planning-compare-left'), `design:${designId}`);
  expect(await compareParam()).toBeNull();
  await selectNativeOption(page.locator('#planning-compare-left'), 'permitted');
  expect(await compareParam()).toBe('permitted,built');
  await page.locator('#planning-compare-enable').click();
  expect(await compareParam()).toBeNull();
});

test('the stats button on the divider opens the two sides\' figures, and Side by side comes back to them', async ({ mockApi: page }) => {
  test.setTimeout(120_000);
  await mockBuildingScene(page);
  await openCity(page);
  const designId = await createBuilding(page);
  const { cid, title } = await page.evaluate(id => {
    const w = window as any;
    const record = w.proposalStorage.getProposal(id);
    const plan = w.PlanComposition.create('Figures plan', [record], { city: w.resolveCurrentCityCode(), at: '45.8,15.98,17', mode: '2d', language: 'en' });
    w.PlanWorkspace.save(plan);
    return { cid: plan.cid as string, title: record.title as string };
  }, designId);
  await page.keyboard.press('Escape');
  await openCompareTab(page);
  // Built today beside Permitted massing: no plan to measure, so no stats button.
  await selectNativeOption(page.locator('#planning-compare-left'), 'built');
  await selectNativeOption(page.locator('#planning-compare-right'), 'permitted');
  await page.locator('#planning-compare-enable').click();
  await expect(page.locator('#map .map-compare__handle')).toBeVisible();
  const stats = page.locator('#map').getByRole('button', { name: 'Compare stats', exact: true });
  await expect(stats).toBeHidden();
  // A plan beside a design: both are measured, in one Compare plans dialog.
  await selectNativeOption(page.locator('#planning-compare-left'), `plan:${cid}`);
  await selectNativeOption(page.locator('#planning-compare-right'), `design:${designId}`);
  await expect(page.locator('#map .map-compare__label--before')).toHaveText('Plan: Figures plan', { timeout: 45_000 });
  await page.locator('#planning-views [data-sheet-close]').click();
  await expect(stats).toBeVisible();
  await stats.click();
  const dialog = page.locator('.plan-compare-dialog');
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByRole('heading', { name: 'Compare plans' })).toBeVisible();
  await expect(dialog.locator('th.plan-compare__plan')).toHaveText([/^Present state/, /^Figures plan/, new RegExp(`^${escapeRegExp(title)}`)]);
  // Side by side on the map closes the dialog onto the same two sides.
  await dialog.locator('[data-plan-compare-side-by-side]').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('#planning-compare-left')).toHaveValue(`plan:${cid}`);
  await expect(page.locator('#planning-compare-right')).toHaveValue(`design:${designId}`);
  await expect(page.locator('#map .map-compare__handle')).toBeVisible();
});
