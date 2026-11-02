// Exercise the structure editor's visible file controls and its enclosure removal action.
import { readFileSync } from 'node:fs';
import { test, expect } from '../helpers/fixtures';
import { clickMapPoint, createSpace, openCity, showProposal } from '../helpers/runtime';
import { selectNativeOption } from '../helpers/controls';
const MODEL = readFileSync('../test-assets/test-building.glb');

async function openStructureEditor(page: import('@playwright/test').Page, kind: 'park' | 'square') {
  await openCity(page);
  const proposalId = await createSpace(page, kind);
  const fixtureUpdated = await page.evaluate(async ({ proposalId, kind }) => {
    const w = window as any;
    const decorations = kind === 'park'
      ? { version: 2, trees: [], flowerbeds: [], ponds: [], paths: [], benches: [], enclosures: [], swings: [] }
      : { version: 2, trees: [], fountains: [], benches: [], stalls: [], statues: [], lamps: [] };
    const edited = JSON.parse(JSON.stringify(w.getProposalByIdOrHash(proposalId)));
    if (!edited?.structureProposal) return false;
    edited.structureProposal.decorationDesign = decorations;
    return !!(await w.ProposalManager.updateProposalInPlace(proposalId, edited, { silent: true }))?.applied;
  }, { proposalId, kind });
  expect(fixtureUpdated).toBe(true);
  await showProposal(page, proposalId);
  await page.locator('#proposal-details-footer .btn-edit-geometry').click();
  const editor = page.locator('#structure-geometry-editor');
  await expect(editor.locator('.on-map-editor__panel')).toBeVisible();
  return { proposalId, editor };
}

async function visibleInteriorPoints(page: import('@playwright/test').Page, proposalId: string, count: number): Promise<Array<[number, number]>> {
  return page.evaluate(({ proposalId, count }) => {
    const w = window as any;
    const proposal = w.proposalStorage.getProposal(proposalId);
    const feature = w.turf.feature(proposal.structureProposal.geometry);
    const [west, south, east, north] = w.turf.bbox(feature);
    const map = w.map;
    const mapBox = map.getContainer().getBoundingClientRect();
    const panel = document.querySelector('#structure-geometry-editor .on-map-editor__panel');
    const panelBox = panel?.getBoundingClientRect();
    const points: Array<[number, number]> = [];
    for (let row = 1; row < 20 && points.length < count; row++) {
      for (let column = 1; column < 20 && points.length < count; column++) {
        const coordinate: [number, number] = [west + (east - west) * column / 20, south + (north - south) * row / 20];
        if (!w.turf.booleanPointInPolygon(w.turf.point(coordinate), feature)) continue;
        const pixel = map.latLngToContainerPoint([coordinate[1], coordinate[0]]);
        const x = mapBox.left + pixel.x, y = mapBox.top + pixel.y;
        if (x < mapBox.left + 20 || x > mapBox.right - 20 || y < mapBox.top + 20 || y > mapBox.bottom - 20) continue;
        if (panelBox && x >= panelBox.left && x <= panelBox.right && y >= panelBox.top && y <= panelBox.bottom) continue;
        const target = document.elementFromPoint(x, y);
        if (!target?.closest('.leaflet-container')) continue;
        const previous = points.length ? map.latLngToContainerPoint([points[points.length - 1][1], points[points.length - 1][0]]) : null;
        if (previous && previous.distanceTo(pixel) < 32) continue;
        points.push(coordinate);
      }
    }
    if (points.length < count) throw new Error(`Only found ${points.length} unobstructed points inside the structure`);
    return points;
  }, { proposalId, count });
}

test('the GeoJSON boundary control replaces and saves the structure outline', async ({ mockApi: page }) => {
  const { proposalId, editor } = await openStructureEditor(page, 'park');
  const boundary = {
    type: 'Feature' as const,
    properties: { fixture: 'boundary-import' },
    geometry: await page.evaluate(id => {
      const w = window as any;
      const geometry = w.proposalStorage.getProposal(id)?.structureProposal?.geometry;
      const scaled = w.turf.transformScale(w.turf.feature(geometry), 0.8).geometry;
      if (scaled.type === 'MultiPolygon' && scaled.coordinates.length !== 1) throw new Error('Fixture needs one connected area');
      return { type: 'Polygon', coordinates: scaled.type === 'MultiPolygon' ? scaled.coordinates[0] : scaled.coordinates };
    }, proposalId)
  };
  const chooserPromise = page.waitForEvent('filechooser');
  await editor.locator('[data-role="boundary-import"]').click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: 'park-boundary.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify(boundary)) });
  await editor.locator('[data-action="save"]').click();
  await expect(editor).toHaveCount(0);

  const saved = await page.evaluate(id => (window as any).proposalStorage.getProposal(id)?.structureProposal?.geometry, proposalId);
  expect(saved).toBeDefined();
  expect(saved).toEqual(boundary.geometry);
});

test('a whole-park enclosure can be removed from its selected card and saved', async ({ mockApi: page }) => {
  const { proposalId, editor } = await openStructureEditor(page, 'park');
  await editor.locator('[data-action="fence-park"]').click();
  const card = editor.locator('[data-role="enclosure-card"]');
  await expect(card).toBeVisible();
  await expect(card.locator('[data-role="enclosure-summary"]')).toContainText('whole park');
  await card.locator('[data-action="remove-enclosure"]').click();
  await expect(card).toBeHidden();
  await editor.locator('[data-action="save"]').click();
  await expect(editor).toHaveCount(0);

  const decorations = await page.evaluate(id => (window as any).proposalStorage.getProposal(id)?.structureProposal?.decorationDesign, proposalId);
  expect(decorations).toBeDefined();
  expect(decorations.enclosures).toEqual([]);
});

test('park Lamp, Seesaw, and Slide tools place selectable objects that persist', async ({ mockApi: page }) => {
  const { proposalId, editor } = await openStructureEditor(page, 'park');
  const points = await visibleInteriorPoints(page, proposalId, 3);
  const lamp = points[0]!;
  const seesaw = points[1]!;
  const slide = points[2]!;
  for (const [tool, coordinate] of [['lamp', lamp], ['seesaw', seesaw], ['slide', slide]] as const) {
    const button = editor.locator(`[data-tool="${tool}"]`);
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await clickMapPoint(page, coordinate[0], coordinate[1]);
  }

  const select = editor.locator('[data-tool="select"]');
  await select.click();
  await expect(select).toHaveAttribute('aria-pressed', 'true');
  const objects = editor.locator('.structure-object-controls');
  for (const [label, value] of [['Lamp 1', 'lamps:0'], ['Seesaw 1', 'seesaws:0'], ['Slide 1', 'slides:0']]) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect(objects.getByRole('listbox', { name: 'Select object' })).toHaveValue(value);
  }

  await editor.locator('[data-action="save"]').click();
  await expect(editor).toHaveCount(0);
  const decorations = await page.evaluate(id => (window as any).proposalStorage.getProposal(id)?.structureProposal?.decorationDesign, proposalId);
  for (const [kind, coordinate] of [['lamps', lamp], ['seesaws', seesaw], ['slides', slide]] as const) {
    expect(decorations[kind]).toHaveLength(1);
    expect(decorations[kind][0].bearing).toBe(0);
    // A pointer lands on a screen pixel, then Leaflet converts that pixel back to coordinates.
    expect(decorations[kind][0].coordinate[0]).toBeCloseTo(coordinate[0], 5);
    expect(decorations[kind][0].coordinate[1]).toBeCloseTo(coordinate[1], 5);
  }
});

test('tree height controls stay inside the selected kind range and save the final dimension', async ({ mockApi: page }) => {
  const { proposalId, editor } = await openStructureEditor(page, 'park');
  const tree = (await visibleInteriorPoints(page, proposalId, 1))[0]!;
  await editor.locator('[data-tool="tree"]').click();
  const placement = editor.getByRole('group', { name: 'Place at coordinates', exact: true });
  await placement.getByLabel('Longitude', { exact: true }).fill(String(tree[0]));
  await placement.getByLabel('Latitude', { exact: true }).fill(String(tree[1]));
  await placement.getByLabel('Latitude', { exact: true }).press('Enter');
  const objects = editor.locator('.structure-object-controls');
  await objects.locator('summary').click();
  await selectNativeOption(objects.getByLabel('Tree kind', { exact: true }), 'broadleaf');
  const height = objects.getByLabel('Height (m)', { exact: true });
  await expect(height).toHaveAttribute('min', '6');
  await expect(height).toHaveAttribute('max', '14');
  await height.fill('6');
  await objects.getByRole('button', { name: 'Apply properties', exact: true }).click();
  const card = editor.locator('[data-role="tree-card"]');
  await expect(card).toBeVisible();
  const taller = card.locator('[data-action="tree-taller"]');
  const shorter = card.locator('[data-action="tree-shorter"]');
  await expect(shorter).toBeDisabled();
  await expect(taller).toBeEnabled();
  await taller.click();
  await expect(card.locator('[data-role="tree-summary"]')).toContainText('7.0 m');
  await height.fill('14');
  await objects.getByRole('button', { name: 'Apply properties', exact: true }).click();
  await expect(taller).toBeDisabled();
  await expect(shorter).toBeEnabled();
  await shorter.click();
  await expect(card.locator('[data-role="tree-summary"]')).toContainText('13.0 m');

  await editor.locator('[data-action="save"]').click();
  await expect(editor).toHaveCount(0);
  const decorations = await page.evaluate(id => (window as any).proposalStorage.getProposal(id)?.structureProposal?.decorationDesign, proposalId);
  expect(decorations.trees).toEqual([{ coordinate: tree, kind: 'broadleaf', heightM: 13 }]);
});

test('a furniture model can be uploaded and removed from the square design', async ({ mockApi: page }) => {
  let uploaded: any;
  await page.route('**/models', async route => {
    uploaded = route.request().postDataJSON();
    await route.fulfill({ json: { modelUrl: '/uploads/models/editor-bench.glb' } });
  });
  const { proposalId, editor } = await openStructureEditor(page, 'square');
  const row = editor.locator('[data-furniture-kind="bench"]');
  await expect(row).toBeVisible();
  const chooserPromise = page.waitForEvent('filechooser');
  await row.locator('[data-role="furniture-model-upload"]').click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: 'bench.glb', mimeType: 'model/gltf-binary', buffer: MODEL });
  await expect(row.locator('[data-role="furniture-model-name"]')).toHaveText('bench.glb');
  await expect(row.locator('[data-action="remove-furniture-model"]')).toBeEnabled();
  await row.locator('[data-action="remove-furniture-model"]').click();
  await expect(row.locator('[data-role="furniture-model-name"]')).toHaveText('Default');
  await expect(row.locator('[data-action="remove-furniture-model"]')).toBeDisabled();
  await editor.locator('[data-action="save"]').click();
  await expect(editor).toHaveCount(0);

  const decorations = await page.evaluate(id => (window as any).proposalStorage.getProposal(id)?.structureProposal?.decorationDesign, proposalId);
  expect(decorations).toBeDefined();
  expect(uploaded.fileName).toBe('bench.glb');
  expect(Buffer.from(uploaded.modelData.split(',')[1], 'base64')).toEqual(MODEL);
  expect(decorations.models?.bench).toBeUndefined();
});
