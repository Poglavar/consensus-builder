// Real local creation and editor actions for the discard guard and Block parameter history.
import { test, expect } from '../helpers/fixtures';
import { createSpace, openCity, openParcel, openBlockEditor, proposalState, showProposal } from '../helpers/runtime';
import { installLayerDatasets } from '../helpers/mocks/layer-datasets';
import type { Page } from '@playwright/test';

async function openStructure(page: Page, id: string) {
  await showProposal(page, id);
  await page.locator('#proposal-details-footer .btn-edit-geometry').click();
  await expect(page.locator('#structure-geometry-editor .on-map-editor__panel')).toBeVisible();
}

async function changeStructure(page: Page, kind: 'park' | 'square' | 'lake') {
  const editor = page.locator('#structure-geometry-editor');
  if (kind !== 'lake') {
    const trees = page.locator('.structure-geometry-icon.is-tree');
    const before = await trees.count();
    await editor.locator('[data-tool="tree"]').click();
    const point = await page.evaluate(() => {
      const w = window as any;
      const geometry = w.getActiveProposalDesignDraft().editorPayload.structureProposal.geometry;
      const box = w.turf.bbox(geometry), mapBox = w.map.getContainer().getBoundingClientRect();
      for (const fx of [0.23, 0.37, 0.63, 0.77]) for (const fy of [0.23, 0.37, 0.63, 0.77]) {
        const coordinate = [box[0] + (box[2] - box[0]) * fx, box[1] + (box[3] - box[1]) * fy];
        if (!w.turf.booleanPointInPolygon(w.turf.point(coordinate), geometry)) continue;
        const pixel = w.map.latLngToContainerPoint([coordinate[1], coordinate[0]]);
        const x = mapBox.left + pixel.x, y = mapBox.top + pixel.y;
        const target = document.elementFromPoint(x, y);
        if (target && !target.closest('button, .leaflet-marker-icon, .structure-geometry-icon, .on-map-editor__panel')) return { x, y };
      }
      throw new Error('No unobstructed planting point in the authored boundary');
    });
    await page.mouse.click(point.x, point.y);
    await expect(trees).toHaveCount(before + 1);
  } else {
    const vertex = page.locator('.polygon-geometry-editor__vertex').first();
    await expect(vertex).toBeVisible();
    const box = await vertex.boundingBox();
    if (!box) throw new Error('Lake boundary vertex is not visible');
    const center = await page.evaluate(() => {
      const w = window as any;
      const geometry = w.getActiveProposalDesignDraft().editorPayload.structureProposal.geometry;
      const [lng, lat] = w.turf.centroid(geometry).geometry.coordinates;
      const p = w.map.latLngToContainerPoint([lat, lng]);
      const rect = w.map.getContainer().getBoundingClientRect();
      return { x: rect.left + p.x, y: rect.top + p.y };
    });
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + (center.x - x) * 0.12, y + (center.y - y) * 0.12, { steps: 6 });
    await page.mouse.up();
  }
  await expect(editor.locator('[data-action="undo"]')).toBeEnabled();
}

for (const kind of ['park', 'square', 'lake'] as const) {
  test(`${kind}: dirty header Cancel and Escape offer Keep editing and Discard`, async ({ mockApi: page }, testInfo) => {
    test.setTimeout(90_000);
    await openCity(page);
    const id = await createSpace(page, kind);
    const before = (await proposalState(page, id)).structureProposal;
    for (const route of ['header', 'escape'] as const) {
      await openStructure(page, id);
      await changeStructure(page, kind);
      const editor = page.locator('#structure-geometry-editor');
      const close = async () => {
        if (route === 'header') await editor.locator('.on-map-editor__header .close-circle-btn').click();
        else await page.keyboard.press('Escape');
      };
      await close();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toBeVisible();
      if (route === 'header') await page.screenshot({ path: testInfo.outputPath(`${kind}-discard-confirmation.png`) });
      await dialog.getByRole('button', { name: 'Keep editing' }).click();
      await expect(editor.locator('.on-map-editor__panel')).toBeVisible();
      await expect(editor.locator('[data-action="undo"]')).toBeEnabled();
      await close();
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Discard' }).click();
      await expect(editor).toHaveCount(0);
      expect((await proposalState(page, id)).structureProposal).toEqual(before);
    }
    await openStructure(page, id);
    await expect(page.locator('#structure-geometry-editor [data-action="undo"]')).toBeDisabled();
    await page.locator('#structure-geometry-editor .on-map-editor__header .close-circle-btn').click();
    await expect(page.locator('#structure-geometry-editor')).toHaveCount(0);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
  });
}

test('Block parameter changes enable visible Undo and restore controls and preview', async ({ mockApi: page }) => {
  test.setTimeout(90_000);
  await installLayerDatasets(page);
  await openCity(page);
  await openParcel(page, 'proposals', 'HR-335754-1237');
  await openBlockEditor(page);
  const editor = page.locator('#blockify-modal');
  await expect(editor.locator('#btn-blockify-done')).toBeEnabled({ timeout: 20_000 });
  const more = editor.locator('.on-map-editor__more-options');
  if (!(await more.evaluate((el: HTMLDetailsElement) => el.open))) await more.locator('> summary').click();
  const undo = page.locator('.geom-undo-button');
  const preview = () => page.evaluate(() => JSON.stringify((window as any).OnMapEditor.getPreview()));
  const change = async (id: string) => {
    const slider = editor.locator(`#${id}`);
    await expect(slider).toBeVisible();
    const before = { value: await slider.inputValue(), preview: await preview() };
    await slider.focus(); await slider.press('ArrowRight');
    await expect(slider).not.toHaveValue(before.value);
    await expect(undo).toBeEnabled();
    await expect.poll(preview).not.toBe(before.preview);
    return before;
  };
  const restore = async (id: string, before: { value: string; preview: string }) => {
    await undo.focus(); await page.keyboard.press('Control+z');
    await expect(editor.locator(`#${id}`)).toHaveValue(before.value);
    await expect.poll(preview).toBe(before.preview);
  };
  for (const id of ['height-slider', 'setback-slider']) {
    const before = await change(id);
    await restore(id, before);
    await expect(undo).toBeDisabled();
  }
  for (const [countId, sizeId] of [['gaps-slider', 'gap-width-slider'], ['wings-slider', 'wing-length-slider']]) {
    const beforeCount = await change(countId);
    const beforeSize = await change(sizeId);
    await restore(sizeId, beforeSize);
    await expect(undo).toBeEnabled();
    await restore(countId, beforeCount);
    await expect(undo).toBeDisabled();
  }
});
