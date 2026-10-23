// The surroundings choice stays with each building design through editing, saving and publication.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, showProposal, proposalState, closeParcel, showSelectionDesignTab } from '../helpers/runtime';
import { selectNativeOption } from '../helpers/controls';
import { installLayerDatasets } from '../helpers/mocks/layer-datasets';

async function finishEditor(page: any, editor: any, done: string) {
  const acceptance = editor.locator('[data-land-accept]');
  if (await acceptance.count()) {
    await expect(acceptance).toBeEnabled();
    await acceptance.check();
  }
  await page.locator(done).click();
  const proceed = page.getByRole('button', { name: 'Proceed anyway' });
  await expect.poll(async () => await editor.count() === 0 || await proceed.isVisible()).toBe(true);
  if (await proceed.isVisible()) await proceed.click();
  await expect(editor).toHaveCount(0);
}

async function openBuildingEditor(page: any, tool: string, typology: string, done: string) {
    if (typology === 'parcelBased') await page.setViewportSize({ width: 375, height: 812 });
    if (typology === 'row') await installLayerDatasets(page);
    await openCity(page);
    if (typology === 'row') {
      // A row needs multiple parcels: select the fixture block through the ordinary palette flow.
      await page.evaluate(async () => { await (window as any).CadastralParcelRepository.ensureIds([
        'HR-335754-1234', 'HR-335754-1235', 'HR-335754-1236', 'HR-335754-1237', 'HR-335754-1238'
      ]); });
      await openParcel(page, 'info');
      await page.locator('.multi-select-detect-btn').click();
      await expect.poll(() => page.evaluate(() => (window as any).multiParcelSelection.selectedParcels.size)).toBeGreaterThan(1);
      await closeParcel(page);
      await showSelectionDesignTab(page);
    } else await openParcel(page, 'proposals');
    await page.locator(`.parcel-build-btn--${tool}`).click();
    const scope = page.getByRole('alertdialog');
    await expect.poll(async () => await scope.isVisible() || await page.locator(done).isVisible(), { timeout: 45_000 }).toBe(true);
    if (await scope.isVisible()) await scope.getByRole('button', { name: 'No, just this parcel' }).click();
    await expect(page.locator(done)).toBeEnabled({ timeout: 45_000 });
    if (typology === 'single') {
      await expect(page.locator('[data-land-accept]')).toBeEnabled();
      await page.locator('[data-land-whole]').click();
      await expect(page.locator('[data-land-accept]')).toBeEnabled();
    }
}

async function openOptions(parent: any) {
  const summary = parent.locator('details > summary').first();
  if (await summary.count()) await summary.click();
}

for (const [tool, typology, root, prefix, done] of [
  ['buildings', 'block', '#blockify-modal', 'blockify', '#btn-blockify-done'],
  ['row', 'row', '#rowhouse', 'rowhouse', '#btn-rowhouse-done'],
  ['parcelBased', 'parcelBased', '#parcelbased', 'parcelbased', '#btn-parcelbased-done']
]) {
  test(`${typology} surroundings preview, save, publish and reopen`, async ({ mockApi: page }) => {
    await openBuildingEditor(page, tool, typology, done);
    const editor = page.locator(root);
    await expect(page.locator(done)).toBeEnabled({ timeout: 20_000 });
    await editor.locator('.on-map-editor__more-options > summary').click();
    const select = page.locator(`#${prefix}-ground-treatment`);
    await expect(select).toHaveValue('none');
    await selectNativeOption(select, 'green');
    await expect.poll(() => page.evaluate(() => (window as any).OnMapEditor.getPreview()?.groundSurface?.treatment)).toBe('green');
    const preview = await page.evaluate(() => (window as any).OnMapEditor.getPreview().groundSurface);
    expect(preview.polygon.type).toMatch(/Polygon/);
    await finishEditor(page, editor, done);
    const id = await page.evaluate(key => (window as any).proposalStorage.getAllProposals()
      .find((p: any) => p.buildingProposal?.typologyType === key)?.proposalId, typology);
    expect(id).toBeTruthy();
    expect((await proposalState(page, id)).geometry.groundSurface).toEqual(preview);
    const published = await page.evaluate(id => {
      const w = window as any;
      const saved = w.proposalStorage.getAllProposals().find((p: any) => p.proposalId === id);
      const content = w.DesignRecord.published(saved);
      const imported = w.DesignSync.localDesignFromRow({ cid: w.Cid.cidOfObject(content), content }, { apiBase: location.origin });
      return { content: content.geometry.groundSurface, imported: imported.geometry.groundSurface };
    }, id);
    expect(published.content).toEqual(preview);
    expect(published.imported).toEqual(preview);

    await showProposal(page, id);
    await page.locator('#proposal-details-footer .btn-edit-geometry').click();
    await expect(page.locator(done)).toBeEnabled({ timeout: 20_000 });
    await editor.locator('.on-map-editor__more-options > summary').click();
    await expect(select).toHaveValue('green');
    await selectNativeOption(select, 'paved');
    await finishEditor(page, editor, done);
    expect((await proposalState(page, id)).geometry.groundSurface.treatment).toBe('paved');

    await showProposal(page, id);
    await page.locator('#proposal-details-footer .btn-edit-geometry').click();
    await expect(page.locator(done)).toBeEnabled({ timeout: 20_000 });
    await editor.locator('.on-map-editor__more-options > summary').click();
    await expect(select).toHaveValue('paved');
    await selectNativeOption(select, 'none');
    await finishEditor(page, editor, done);
    expect((await proposalState(page, id)).geometry.groundSurface).toBeUndefined();
  });
}

// Read-only geometry-to-screen lookup: choose two clear points strictly within the current surface.
async function furniturePoints(page: any, surface: any) {
  return page.evaluate((surface: any) => {
    const w = window as any;
    const ground = w.turf.feature(surface.polygon);
    const inset = w.turf.buffer(ground, -0.0002, { units: 'kilometers' }) || ground;
    const points = w.turf.coordAll(inset).concat([w.turf.pointOnFeature(inset).geometry.coordinates]);
    const box = w.map.getContainer().getBoundingClientRect();
    const clear: any[] = [];
    for (const [lng, lat] of points) {
      const pixel = w.map.latLngToContainerPoint([lat, lng]);
      const point = { x: box.left + pixel.x, y: box.top + pixel.y };
      const top = document.elementFromPoint(point.x, point.y);
      if (!top || top.closest('.on-map-editor') || !w.map.getContainer().contains(top)) continue;
      if (!w.turf.booleanPointInPolygon([lng, lat], ground)) continue;
      if (clear.every(p => Math.hypot(p.x - point.x, p.y - point.y) > 30)) clear.push(point);
      if (clear.length === 2) return clear;
    }
    throw new Error('No two clear points within the surroundings');
  }, surface);
}

for (const [tool, typology, root, prefix, done, treatment] of [
  ['buildings', 'block', '#blockify-modal', 'blockify', '#btn-blockify-done', 'green'],
  ['row', 'row', '#rowhouse', 'rowhouse', '#btn-rowhouse-done', 'paved'],
  ['parcelBased', 'parcelBased', '#parcelbased', 'parcelbased', '#btn-parcelbased-done', 'green'],
  ['single', 'single', '#single-building-editor', 'single', '#single-building-confirm', 'paved']
]) {
  test(`${typology} authored surroundings edit, cancel, save and upload round trip`, async ({ mockApi: page }) => {
    test.setTimeout(60_000);
    await openBuildingEditor(page, tool, typology, done);
    const parent = page.locator(root);
    await openOptions(parent);
    const edit = page.locator(`#${prefix}-ground-treatment-edit`);
    await expect(edit).toBeDisabled();
    await selectNativeOption(page.locator(`#${prefix}-ground-treatment`), treatment);
    await expect(edit).toBeEnabled();
    const surfaceForPoints = await page.evaluate(() => (window as any).OnMapEditor.getPreview().groundSurface);
    await edit.click();
    const child = page.locator('#structure-geometry-editor');
    await expect(child.locator('.on-map-editor__panel')).toBeVisible();
    await expect(parent.locator('.on-map-editor__panel')).toBeHidden();
    await expect(page.locator('#mode-3d-toggle')).toBeDisabled();
    const points = await furniturePoints(page, surfaceForPoints);
    await expect(child.locator('[data-tool="move"]')).toHaveCount(0);
    await child.locator('[data-tool="tree"]').click();
    await page.mouse.click(points[0].x, points[0].y);
    await expect(page.locator('.structure-geometry-icon.is-tree')).toHaveCount(1);
    await child.locator('.on-map-editor__header .close-circle-btn').click();
    await expect(child).toHaveCount(0);
    await expect(parent.locator('.on-map-editor__panel')).toBeVisible();
    await expect(page.locator('#mode-3d-toggle')).toBeEnabled();
    expect(await page.evaluate(() => (window as any).OnMapEditor.getPreview().groundSurface.decorationDesign || null)).toBeNull();

    await edit.click();
    await expect(page.locator('.structure-geometry-icon.is-tree')).toHaveCount(0);
    await child.locator('[data-tool="tree"]').click();
    await page.mouse.click(points[0].x, points[0].y);
    await child.locator('[data-tool="bench"]').click();
    await page.mouse.click(points[1].x, points[1].y);
    await expect(page.locator('.structure-geometry-icon.is-bench')).toHaveCount(1);
    await child.locator('[data-action="save"]').click();
    await expect(child).toHaveCount(0);
    await expect(parent.locator('.on-map-editor__panel')).toBeVisible();
    const surface = await page.evaluate(() => (window as any).OnMapEditor.getPreview().groundSurface);
    await expect(page.locator('#mode-3d-toggle')).toBeEnabled();
    expect(surface.decorationDesign.trees).toHaveLength(1);
    expect(surface.decorationDesign.benches).toHaveLength(1);
    expect(await page.evaluate(() => (window as any).proposalStorage.getAllProposals().length)).toBe(0);
    await finishEditor(page, parent, done);
    const saved = await page.evaluate(() => (window as any).proposalStorage.getAllProposals().slice(-1)[0]);
    expect(saved.geometry.groundSurface).toEqual(surface);
    const imported = await page.evaluate(record => {
      const w = window as any;
      const content = JSON.parse(JSON.stringify(w.DesignRecord.published(record)));
      return w.DesignSync.localDesignFromRow({ content, cid: w.Cid.cidOfObject(content) }, { apiBase: location.origin });
    }, saved);
    expect(imported.geometry.groundSurface).toEqual(surface);
    expect(imported.structureProposal).toBeUndefined();
    await showProposal(page, saved.proposalId);
    await page.locator('#proposal-details-footer .btn-edit-geometry').click();
    await expect(page.locator(done)).toBeEnabled({ timeout: 20_000 });
    await openOptions(parent);
    await edit.click();
    await expect(page.locator('.structure-geometry-icon.is-tree')).toHaveCount(1);
    await expect(page.locator('.structure-geometry-icon.is-bench')).toHaveCount(1);
    await expect(page.locator('.park-tree-emoji, .square-tree-emoji')).toHaveCount(0);
    await child.locator('.on-map-editor__header .close-circle-btn').click();
    // Cancelling the entire building edit leaves the saved layout unchanged.
    await parent.locator('.on-map-editor__header .close-circle-btn').click();
    expect((await proposalState(page, saved.proposalId)).geometry.groundSurface).toEqual(surface);
  });
}
