// Exercise geometry editing through named native controls and keyboard activation, including saved state.
import { test, expect } from '../helpers/fixtures';
import { openCity } from '../helpers/runtime';
import type { Page } from '@playwright/test';

const SITE = { type: 'Polygon', coordinates: [[[15.9819,45.8],[15.9825,45.8],[15.9825,45.8005],[15.9819,45.8005],[15.9819,45.8]]] };

async function openDraft(page: Page, kind: 'park' | 'lake') {
  await openCity(page);
  await page.waitForFunction(() => !!(window as any).GeometryCoordinateControls);
  const id = await page.evaluate(async ({ kind, geometry }) => {
    const w = window as any;
    const draft = w.proposalDraftStore.createDraft({ cityId: w.CityConfigManager.getCurrentCityId(), goal: kind, adapterKey: kind,
      fields: { name: 'Accessible garden', description: '', site: geometry, selectedParcelIds: [] },
      editorPayload: { structureProposal: { kind, geometry, ...(kind === 'park' ? { decorationDesign: {
        version: 3, trees: [{ coordinate: [15.9821,45.8002], kind: 'broadleaf', heightM: 10 }],
        benches: [{ coordinate: [15.9823,45.8002], bearing: 35 }],
        paths: [[[15.98205,45.8003],[15.98235,45.8003]]], ponds: [], flowerbeds: []
      } } : {}) } } });
    if (!await w.openProposalDraftDesign(draft.id)) throw new Error('Could not open test draft');
    return draft.id;
  }, { kind, geometry: SITE });
  const editor = page.locator('#structure-geometry-editor');
  await expect(editor.getByRole('heading', { name: kind === 'lake' ? 'Lake boundary editor' : 'Park editor' })).toBeFocused();
  return { id, editor };
}

async function marker(page: Page, title: string) {
  return page.evaluate(title => {
    const w = window as any;
    const layer: any = Object.values(w.map._layers).find((layer: any) => layer.options?.title === title);
    if (!layer) throw new Error(`Missing rendered marker ${title}`);
    const { lng, lat } = layer.getLatLng();
    return [lng, lat];
  }, title);
}

async function boundary(page: Page) {
  return page.evaluate(() => {
    const w = window as any;
    const layer: any = Object.values(w.map._layers).find((layer: any) => layer._path?.classList.contains('structure-geometry-boundary'));
    return layer.toGeoJSON().geometry;
  });
}

async function saved(page: Page, id: string) {
  return page.evaluate(id => (window as any).proposalDraftStore.getDraft(id)?.editorPayload.structureProposal, id);
}

test.describe('Accessible map editing @features', () => {
  test('searches, moves and edits objects with keyboard actions, preserves focus and undoes changes', async ({ mockApi: page }) => {
    const { id, editor } = await openDraft(page, 'park');
    await page.keyboard.press('Tab');
    await expect(editor.getByRole('button', { name: 'Hide controls', exact: true })).toBeFocused();
    const objects = editor.locator('.structure-object-controls');
    await objects.locator('summary').focus();
    await page.keyboard.press('Enter');
    const search = objects.getByRole('searchbox', { name: 'Search objects' });
    await search.fill('Tree');
    await expect(objects.getByRole('listbox', { name: 'Select object' }).getByRole('option')).toHaveText(['Tree 1']);
    const before = await marker(page, 'Tree 1');
    await objects.getByLabel('Move distance (m)').fill('2');
    const east = objects.getByRole('button', { name: 'East 2 m', exact: true });
    await east.focus();
    await page.keyboard.press('Enter');
    await expect(east).toBeFocused();
    const after = await marker(page, 'Tree 1');
    expect(await page.evaluate(({ before, after }) => (window as any).turf.distance(before, after, { units: 'meters' }), { before, after })).toBeCloseTo(2, 4);
    await expect(objects.getByRole('status').filter({ hasText: 'Position updated:' })).toBeVisible();
    await editor.getByRole('button', { name: 'Undo', exact: true }).press('Enter');
    expect(await marker(page, 'Tree 1')).toEqual(before);
    await objects.getByLabel('Tree kind', { exact: true }).selectOption('columnar');
    await objects.getByLabel('Height (m)', { exact: true }).fill('12');
    await objects.getByRole('button', { name: 'Apply properties', exact: true }).press('Enter');
    await search.fill('Bench');
    await expect(objects.getByRole('listbox', { name: 'Select object' }).getByRole('option')).toHaveText(['Bench 1']);
    await objects.getByLabel('Latitude', { exact: true }).fill('');
    await objects.getByRole('button', { name: 'Apply coordinates', exact: true }).press('Enter');
    await expect(objects.getByLabel('Latitude', { exact: true })).toHaveAttribute('aria-invalid', 'true');
    expect(await marker(page, 'Bench 1')).toEqual([15.9823,45.8002]);
    await objects.getByLabel('Latitude', { exact: true }).fill('45.80021');
    await objects.getByLabel('Longitude', { exact: true }).fill('15.9823');
    await objects.getByLabel('Latitude', { exact: true }).press('Enter');
    expect(await marker(page, 'Bench 1')).toEqual([15.9823,45.80021]);
    await objects.getByRole('button', { name: 'Remove object', exact: true }).press('Enter');
    await expect(objects.getByRole('listbox', { name: 'Select object' })).toBeFocused();
    await expect(objects.getByRole('listbox', { name: 'Select object' }).getByRole('option')).toHaveCount(0);
    await editor.getByRole('button', { name: 'Undo', exact: true }).press('Enter');
    expect(await marker(page, 'Bench 1')).toEqual([15.9823,45.80021]);
    await editor.getByRole('button', { name: 'Done', exact: true }).press('Enter');
    await expect(editor).toHaveCount(0);
    const result = await saved(page, id);
    expect(result.decorationDesign.trees[0]).toEqual({ coordinate: before, kind: 'columnar', heightM: 12 });
    expect(result.decorationDesign.benches[0]).toEqual({ coordinate: [15.9823,45.80021], bearing: 35 });
  });

  test('edits, inserts and removes lake vertices without dragging and rejects invalid shapes', async ({ mockApi: page }) => {
    const { id, editor } = await openDraft(page, 'lake');
    await editor.getByRole('checkbox', { name: 'Snap to edges', exact: true }).uncheck();
    const vertices = editor.locator('details').filter({ has: page.locator('summary', { hasText: 'Edit vertices' }) });
    await vertices.locator('summary').press('Enter');
    await vertices.getByLabel('Vertex', { exact: true }).selectOption('1');
    await expect(page.getByRole('button', { name: 'Vertex 2', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await vertices.getByLabel('Longitude', { exact: true }).fill('15.9824');
    await vertices.getByLabel('Latitude', { exact: true }).fill('45.80005');
    await vertices.getByLabel('Latitude', { exact: true }).press('Enter');
    const edited = await boundary(page);
    expect(edited.coordinates[0][1]).toEqual([15.9824,45.80005]);
    await vertices.getByRole('button', { name: 'Add point after', exact: true }).press('Enter');
    expect((await boundary(page)).coordinates[0]).toHaveLength(6);
    await vertices.getByRole('button', { name: 'Remove point', exact: true }).press('Enter');
    expect((await boundary(page)).coordinates[0]).toHaveLength(5);
    await editor.getByRole('button', { name: 'Undo', exact: true }).press('Enter');
    expect((await boundary(page)).coordinates[0]).toHaveLength(6);
    await editor.getByRole('button', { name: 'Undo', exact: true }).press('Enter');
    expect(await boundary(page)).toEqual(edited);
    await vertices.getByLabel('Vertex', { exact: true }).selectOption('1');
    await vertices.getByLabel('Longitude', { exact: true }).fill('15.9819');
    await vertices.getByLabel('Latitude', { exact: true }).fill('45.8005');
    await vertices.getByRole('button', { name: 'Apply coordinates', exact: true }).press('Enter');
    await expect(vertices.getByRole('status')).toHaveText('This change does not fit the allowed boundary or shape.');
    expect(await boundary(page)).toEqual(edited);
    await editor.getByRole('button', { name: 'Done', exact: true }).press('Enter');
    const result = await saved(page, id);
    expect(result.geometry).toEqual(edited);
    expect(result.lakeGraphics.geometry).toEqual(edited);
  });

  test('keeps focus and distinct outline controls while a courtyard building redraws', async ({ mockApi: page }) => {
    await openCity(page);
    const hole = [[15.98206,45.80016],[15.98206,45.8002],[15.9821,45.8002],[15.9821,45.80016],[15.98206,45.80016]];
    await page.evaluate(async ({ site, hole }) => {
      const w = window as any;
      const building = { type: 'Feature', properties: { height: 12, floors: 4 }, geometry: { type: 'Polygon', coordinates: [
        [[15.982,45.8001],[15.9822,45.8001],[15.9822,45.8003],[15.982,45.8003],[15.982,45.8001]], hole
      ] } };
      const draft = w.proposalDraftStore.createDraft({ cityId: w.CityConfigManager.getCurrentCityId(), goal: 'single', adapterKey: 'single',
        fields: { name: 'Courtyard', description: '', site, selectedParcelIds: [] },
        editorPayload: { typology: 'single', context: { buildings: [building] } } });
      if (!await w.openProposalDraftDesign(draft.id)) throw new Error('Could not open courtyard editor');
    }, { site: SITE, hole });
    const editor = page.locator('#single-building-editor');
    const outline = editor.locator('details').filter({ has: page.locator('summary', { hasText: /^Outline 1 vertices$/ }) });
    const courtyard = editor.locator('details').filter({ has: page.locator('summary', { hasText: /^Outline 1, hole 1 vertices$/ }) });
    await expect(courtyard).toBeVisible();
    await outline.locator('summary').press('Enter');
    await outline.getByLabel('Vertex', { exact: true }).selectOption('1');
    const longitude = outline.getByLabel('Longitude', { exact: true });
    await longitude.fill('15.98219');
    const fieldId = await longitude.getAttribute('id');
    await longitude.press('Enter');
    await expect(longitude).toBeFocused();
    await expect(longitude).toHaveAttribute('id', fieldId!);
    await expect(outline).toHaveAttribute('open', '');
    await expect(longitude).toHaveValue('15.98219');
    const geometry = await page.evaluate(() => {
      const w = window as any;
      const layer: any = Object.values(w.map._layers).find((layer: any) => layer._path?.classList.contains('single-building-fill'));
      return layer.toGeoJSON().geometry;
    });
    expect(geometry.coordinates[0][1]).toEqual([15.98219,45.8001]);
    expect(geometry.coordinates[1]).toEqual(hole);
  });

  test('places a path from coordinate fields on a narrow screen and retains thumbnail descriptions', async ({ mockApi: page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { id, editor } = await openDraft(page, 'park');
    await editor.getByRole('button', { name: 'Footpath', exact: true }).press('Enter');
    const placement = editor.getByRole('group', { name: 'Place at coordinates', exact: true });
    await placement.getByLabel('Longitude', { exact: true }).fill('15.9821');
    await placement.getByLabel('Latitude', { exact: true }).fill('45.8001');
    await placement.getByLabel('Latitude', { exact: true }).press('Enter');
    await expect(editor.getByRole('button', { name: 'Finish path', exact: true })).toBeDisabled();
    await placement.getByLabel('Longitude', { exact: true }).fill('15.9823');
    await placement.getByLabel('Latitude', { exact: true }).press('Enter');
    await expect(editor.getByRole('button', { name: 'Finish path', exact: true })).toBeEnabled();
    await editor.getByRole('button', { name: 'Finish path', exact: true }).press('Enter');
    await expect(editor.getByRole('button', { name: 'Finish path', exact: true })).toBeDisabled();
    await editor.getByRole('button', { name: 'Hide controls', exact: true }).press('Enter');
    await expect(editor.getByRole('button', { name: 'Show controls', exact: true })).toBeFocused();
    const panel = await editor.locator('.on-map-editor__panel').boundingBox();
    expect(panel!.x).toBeGreaterThanOrEqual(0);
    expect(panel!.x + panel!.width).toBeLessThanOrEqual(390);
    await expect(editor.getByRole('button', { name: 'Done', exact: true })).toBeInViewport();
    await editor.getByRole('button', { name: 'Done', exact: true }).press('Enter');
    expect((await saved(page, id)).decorationDesign.paths).toContainEqual([[15.9821,45.8001],[15.9823,45.8001]]);
    await page.evaluate(() => {
      const w = window as any, container = document.createElement('div');
      container.id = 'accessible-thumb-check';
      container.innerHTML = w.buildProposalThumbHtml({ proposalId: 'accessible-image', title: 'Garden "A"', goal: 'park' });
      document.body.appendChild(container);
      document.dispatchEvent(new CustomEvent('proposalScreenshotUpdated', { detail: { proposalId: 'accessible-image', screenshotDataUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' } }));
    });
    const thumbnail = page.locator('#accessible-thumb-check');
    await expect(thumbnail.locator('.proposal-thumb-img')).toHaveAttribute('alt', 'Design preview: Garden "A"');
    await expect(thumbnail.locator('.proposal-thumb-large')).toHaveAttribute('aria-hidden', 'true');
    await expect(thumbnail.locator('.proposal-thumb-large img')).toHaveAttribute('alt', '');
  });
});
