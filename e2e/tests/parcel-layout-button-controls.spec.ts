// Exercise every control of the parcel-layout editor ("Lay out parcels") by its effect on the plots,
// the map and the saved layout: starting layouts and plot count, the plot tabs, the drawing tools,
// edit history, GeoJSON import, Before / after, the courtyard tool, Done, Cancel and Close.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, PARCEL_ID } from '../helpers/runtime';
import type { Locator, Page } from '@playwright/test';

test.beforeEach(async ({ mockApi: page }) => {
  await page.route(/https:\/\/[^/]*tile\.openstreetmap\.org\//, route => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#eee"/></svg>',
  }));
});

// Two plots whose shared border bends; together they cover parcel 1234 exactly.
const TWO_PLOTS = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { label: 'West plot' }, geometry: { type: 'Polygon', coordinates: [[[15.9819, 45.8], [15.9821, 45.8], [15.98215, 45.80025], [15.9821, 45.8005], [15.9819, 45.8005], [15.9819, 45.8]]] } },
    { type: 'Feature', properties: { label: 'East plot' }, geometry: { type: 'Polygon', coordinates: [[[15.9821, 45.8], [15.9825, 45.8], [15.9825, 45.8005], [15.9821, 45.8005], [15.98215, 45.80025], [15.9821, 45.8]]] } },
  ],
};

async function editorReady(page: Page): Promise<Locator> {
  const editor = page.locator('.on-map-reparcellization');
  await expect(editor.locator('.on-map-editor__panel')).toBeVisible();
  await expect(editor.locator('[data-reparcel-commit]')).toBeEnabled({ timeout: 15_000 });
  return editor;
}

async function launchFromPalette(page: Page): Promise<Locator> {
  await openParcel(page, 'proposals', PARCEL_ID);
  await page.locator('.parcel-build-btn--parcel-layout').click();
  return editorReady(page);
}

async function openLayoutEditor(page: Page): Promise<Locator> {
  await openCity(page);
  await page.evaluate(() => (window as any).i18n.setLanguage('en'));
  return launchFromPalette(page);
}

const rows = (editor: Locator) => editor.locator('[data-reparcel-newplots-table] .reparcel-newplot-row');
const option = (editor: Locator, value: string) => editor.locator(`label.reparcel-alg-option:has(input[value="${value}"])`);
const status = (editor: Locator) => editor.locator('[data-reparcel-status]');

async function setPlotCount(editor: Locator, value: number) {
  const count = editor.locator('[data-parcel-layout-count]');
  await count.fill(String(value));
  await count.press('Enter');
}

// Every parcel layout saved so far, applied or not.
const layoutRecords = (page: Page) => page.evaluate(() => (window as any).proposalStorage.getAllProposals()
  .filter((proposal: any) => proposal.goal === 'parcel-layout').map((proposal: any) => proposal.proposalId));

async function appliedLayout(page: Page): Promise<any> {
  await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals()
    .filter((proposal: any) => proposal.applied && proposal.goal === 'parcel-layout').length)).toBe(1);
  return page.evaluate(() => JSON.parse(JSON.stringify((window as any).proposalStorage.getAllProposals()
    .find((proposal: any) => proposal.applied && proposal.goal === 'parcel-layout'))));
}

// Screen points from fractions of the pool's bounding box (its red outline), each checked to land on
// the map itself, clear of the editor's panels and handles. `shapes` lists candidate point sets.
async function poolPoints(page: Page, shapes: number[][][]): Promise<Array<{ x: number; y: number }>> {
  return page.evaluate(candidates => {
    const w = window as any;
    const map = w.map;
    let geometry: any = null;
    map.eachLayer((layer: any) => {
      if (layer.options?.pane === 'reparcelTools' && layer.options.color === '#dc2626'
        && layer._path?.isConnected && layer.feature?.geometry) geometry = layer.feature.geometry;
    });
    if (!geometry) throw new Error('The parcel layout has no rendered pool outline');
    const [minLng, minLat, maxLng, maxLat] = w.turf.bbox({ type: 'Feature', properties: {}, geometry });
    const mapRect = map.getContainer().getBoundingClientRect();
    const obstacles = [...document.querySelectorAll('.on-map-reparcellization .on-map-editor__panel, .reparcel-tools')]
      .map(element => element.getBoundingClientRect());
    const screenOf = ([xRatio, yRatio]: number[]) => {
      const point = map.latLngToContainerPoint([minLat + (maxLat - minLat) * yRatio, minLng + (maxLng - minLng) * xRatio]);
      return { x: mapRect.left + point.x, y: mapRect.top + point.y };
    };
    const clear = (p: { x: number; y: number }) => {
      if (p.x < mapRect.left + 8 || p.x > mapRect.right - 8 || p.y < mapRect.top + 8 || p.y > mapRect.bottom - 8) return false;
      if (obstacles.some(rect => p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom)) return false;
      const hit = document.elementFromPoint(p.x, p.y);
      return !!hit && map.getContainer().contains(hit) && !hit.closest('.leaflet-marker-icon');
    };
    for (const shape of candidates) {
      const points = shape.map(screenOf);
      if (points.every(clear)) return points;
    }
    throw new Error('No candidate points fit the unobstructed map area');
  }, shapes);
}

// A small triangle inside the western equal plot (or, failing that, the eastern one).
const insideTriangle = (page: Page) => poolPoints(page, [
  [[0.15, 0.25], [0.35, 0.25], [0.15, 0.45]],
  [[0.15, 0.55], [0.35, 0.55], [0.15, 0.75]],
  [[0.65, 0.25], [0.85, 0.25], [0.65, 0.45]],
  [[0.65, 0.55], [0.85, 0.55], [0.65, 0.75]],
]);

// An east-west line across the whole pool, starting and ending just outside it. Equal plots are cut
// north-south, so it crosses every one of them.
const crossingLine = (page: Page) => poolPoints(page, [0.5, 0.4, 0.6, 0.3, 0.7]
  .flatMap(yRatio => [0.08, 0.04, 0.02].map(extension => [[-extension, yRatio], [1 + extension, yRatio]])));

// A point on the first erasable boundary where the boundary itself takes the click.
async function eraseTarget(page: Page): Promise<{ x: number; y: number }> {
  return page.locator('#map-container path.reparcel-erase-line').first().evaluate(element => {
    const path = element as unknown as SVGPathElement;
    const matrix = path.getScreenCTM();
    if (!matrix) throw new Error('The boundary is not on screen');
    for (const fraction of [0.2, 0.8, 0.35, 0.65, 0.5]) {
      const point = path.getPointAtLength(path.getTotalLength() * fraction);
      const screen = { x: point.x * matrix.a + point.y * matrix.c + matrix.e, y: point.x * matrix.b + point.y * matrix.d + matrix.f };
      if (document.elementFromPoint(screen.x, screen.y)?.classList.contains('reparcel-erase-line')) return screen;
    }
    throw new Error('Every point tried on the boundary is covered');
  });
}

test.describe('parcel-layout button controls @core', () => {
  test('Close leaves nothing behind, and Cancel asks before discarding an edit', async ({ mockApi: page }) => {
    let editor = await openLayoutEditor(page);
    await editor.locator('.on-map-editor__header .close-circle-btn').click();
    await expect(editor).toHaveCount(0);
    expect(await layoutRecords(page)).toEqual([]);
    expect(await page.evaluate(() => (window as any).getActiveProposalDesignDraft?.() ?? null)).toBeNull();

    editor = await launchFromPalette(page);
    await setPlotCount(editor, 3);
    await expect(rows(editor)).toHaveCount(3);
    await editor.locator('[data-reparcel-cancel]').click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText('Discard these changes?');
    await confirm.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await expect(rows(editor)).toHaveCount(3);

    await editor.locator('[data-reparcel-cancel]').click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(editor).toHaveCount(0);
    expect(await layoutRecords(page)).toEqual([]);
    // The parcel was never redrawn.
    expect(await page.evaluate(id => !!(window as any).LiveParcelFabric.get(id), PARCEL_ID)).toBe(true);
  });

  test('Done applies the layout: its plots replace the parcel on the map', async ({ mockApi: page }) => {
    const editor = await openLayoutEditor(page);
    await expect(editor.locator('[data-reparcel-coverage]')).toContainText('The plots cover the whole pool');
    const done = editor.locator('[data-reparcel-commit]');
    await expect(done).toHaveText('Done');
    await done.click();
    await expect(editor).toHaveCount(0);
    const layout = await appliedLayout(page);
    expect(layout.parcelLayout.plots).toHaveLength(2);
    expect(await page.evaluate(id => (window as any).LiveParcelFabric.producedBy(id)
      .filter((piece: any) => piece.properties.readjustmentPiece?.role === 'plot').length, layout.proposalId)).toBe(2);
  });

  test('each starting layout replaces the plots, and Draw freely keeps the ones on the map', async ({ mockApi: page }) => {
    const editor = await openLayoutEditor(page);
    const subtitle = editor.locator('.reparcel-subtitle');
    const countField = editor.locator('[data-parcel-layout-count-field]');
    const courtyardTools = editor.locator('[data-reparcel-courtyard-tools]');
    await expect(editor.locator('input[name="reparcel-algorithm"][value="equal"]')).toBeChecked();
    await expect(subtitle).toContainText('Equal plots');
    await expect(rows(editor)).toHaveCount(2);
    await expect(countField).toBeVisible();

    await option(editor, 'schelling').click();
    await expect(editor.locator('input[name="reparcel-algorithm"][value="schelling"]')).toBeChecked();
    await expect(subtitle).toContainText('Schelling plots');
    await expect(status(editor)).toContainText('Plots of Schelling plan');
    await expect(countField).toBeHidden();
    await expect.poll(() => rows(editor).count()).toBeGreaterThan(0);

    // Keep existing borders: the one input parcel is the one plot, and the courtyard tool appears.
    await option(editor, 'amend').click();
    await expect(subtitle).toContainText('Keep existing borders');
    await expect(rows(editor)).toHaveCount(1);
    await expect(status(editor)).toHaveText('The existing parcels are the plots. Carve a courtyard or edit the boundaries.');
    await expect(courtyardTools).toBeVisible();

    await option(editor, 'manual').click();
    await expect(subtitle).toContainText('Draw freely');
    await expect(rows(editor)).toHaveCount(1);
    await expect(status(editor)).toContainText('Drawing freely from the current layout');
    await expect(courtyardTools).toBeHidden();

    await option(editor, 'equal').click();
    await expect(rows(editor)).toHaveCount(2);
    await expect(countField).toBeVisible();
  });

  test('the plot count re-slices equal plots and waits while another layout is chosen', async ({ mockApi: page }) => {
    const editor = await openLayoutEditor(page);
    const count = editor.locator('[data-parcel-layout-count]');
    await expect(count).toHaveAttribute('min', '2');
    await expect(count).toHaveValue('2');
    await setPlotCount(editor, 3);
    await expect(rows(editor)).toHaveCount(3);
    await expect(page.locator('.reparcel-plot-number')).toHaveCount(3);
    // Draw freely keeps the three plots; the count is Equal plots' own field.
    await option(editor, 'manual').click();
    await expect(editor.locator('[data-parcel-layout-count-field]')).toBeHidden();
    await expect(rows(editor)).toHaveCount(3);
    await option(editor, 'equal').click();
    await expect(count).toHaveValue('3');
    await expect(rows(editor)).toHaveCount(3);
  });

  test('New plots and Old plots switch between the layout and the parcel it replaces', async ({ mockApi: page }) => {
    const editor = await openLayoutEditor(page);
    const newTab = editor.locator('[data-reparcel-plots-tab="new"]');
    const oldTab = editor.locator('[data-reparcel-plots-tab="old"]');
    const handles = page.locator('#map-container .reparcel-node-handle');
    await expect(newTab).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => handles.count()).toBeGreaterThan(0);

    const undoWasDisabled = await editor.locator('[data-reparcel-undo-edit]').isDisabled();
    const doneWasDisabled = await editor.locator('[data-reparcel-commit]').isDisabled();
    await oldTab.click();
    await expect(editor.locator('[data-reparcel-alg-group]')).toHaveAttribute('aria-disabled', 'true');
    for (const selector of ['[data-reparcel-draw]', '[data-reparcel-line]', '[data-reparcel-erase]', '[data-reparcel-nodes]', '[data-reparcel-upload]', '[data-reparcel-undo-edit]', '[data-reparcel-redo-edit]', 'input[name="reparcel-algorithm"]']) {
      await expect(editor.locator(selector).first()).toBeDisabled();
    }
    await expect(newTab).toBeEnabled();
    await expect(editor.locator('[data-reparcel-cancel]')).toBeEnabled();
    expect(await editor.locator('[data-reparcel-commit]').isDisabled()).toBe(doneWasDisabled);
    // Keyboard focus cannot enter the disabled toolset, including its enabled-before-switch tools.
    await oldTab.focus();
    for (let index = 0; index < 8; index++) {
      await page.keyboard.press('Tab');
      expect(await editor.locator('[data-reparcel-alg-group]').evaluate(el => el.contains(document.activeElement))).toBe(false);
    }
    await expect(oldTab).toHaveAttribute('aria-selected', 'true');
    await expect(newTab).toHaveAttribute('aria-selected', 'false');
    const oldPlots = editor.locator('[data-reparcel-oldplots-table]');
    await expect(oldPlots).toBeVisible();
    await expect(oldPlots.locator('.reparcel-oldplot-row')).toHaveCount(1);
    await expect(oldPlots).toContainText('1234');
    await expect(editor.locator('[data-reparcel-newplots-table]')).toBeHidden();
    // The parcels being replaced are read-only: no handles and no plot numbers over them.
    await expect(handles).toHaveCount(0);
    await expect(page.locator('.reparcel-plot-number')).toHaveCount(0);
    await expect(editor.locator('[data-reparcel-nodes]')).toHaveAttribute('aria-pressed', 'false');

    await newTab.click();
    await expect(newTab).toHaveAttribute('aria-selected', 'true');
    await expect(editor.locator('[data-reparcel-alg-group]')).toHaveAttribute('aria-disabled', 'false');
    await expect(editor.locator('[data-reparcel-draw]')).toBeEnabled();
    expect(await editor.locator('[data-reparcel-undo-edit]').isDisabled()).toBe(undoWasDisabled);
    expect(await editor.locator('[data-reparcel-commit]').isDisabled()).toBe(doneWasDisabled);
    await expect(editor.locator('[data-reparcel-newplots-table]')).toBeVisible();
    await expect(oldPlots).toBeHidden();
    await expect(editor.locator('[data-reparcel-nodes]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.reparcel-plot-number')).toHaveCount(2);
  });

  test('Draw plot places draft points, Undo point and Cancel take them back, and Finish adds the plot', async ({ mockApi: page }) => {
    const editor = await openLayoutEditor(page);
    // Draw freely keeps the equal plots and takes the sweep handle off the map.
    await option(editor, 'manual').click();
    await expect(status(editor)).toContainText('Drawing freely');
    const draw = editor.locator('[data-reparcel-draw]');
    const toolbar = editor.locator('[data-reparcel-draw-toolbar]');
    const finish = editor.locator('[data-reparcel-finish]');
    const points = page.locator('#map-container .reparcel-vertex-handle');
    await draw.click();
    await expect(draw).toHaveAttribute('aria-pressed', 'true');
    await expect(toolbar).toBeVisible();
    await expect(finish).toHaveText('Finish plot (F)');
    const [a, b, c] = await insideTriangle(page);
    await page.mouse.click(a.x, a.y);
    await page.mouse.click(b.x, b.y);
    await expect(points).toHaveCount(2);
    await expect(finish).toBeDisabled();
    await editor.locator('[data-reparcel-undo]').click();
    await expect(points).toHaveCount(1);
    await expect(rows(editor)).toHaveCount(2);
    await editor.locator('[data-reparcel-cancel-draw]').click();
    await expect(toolbar).toBeHidden();
    await expect(draw).toHaveAttribute('aria-pressed', 'false');
    await expect(points).toHaveCount(0);
    await expect(rows(editor)).toHaveCount(2);

    // Three points make a plot, carved out of the plot under it.
    await draw.click();
    for (const point of [a, b, c]) await page.mouse.click(point.x, point.y);
    await expect(points).toHaveCount(3);
    await expect(finish).toBeEnabled();
    await finish.click();
    await expect(toolbar).toBeHidden();
    await expect(status(editor)).toHaveText('Plot added.');
    await expect(rows(editor)).toHaveCount(3);
  });

  test('Draw a line splits every plot it crosses', async ({ mockApi: page }) => {
    const editor = await openLayoutEditor(page);
    await option(editor, 'manual').click();
    await expect(rows(editor)).toHaveCount(2);
    const line = editor.locator('[data-reparcel-line]');
    const finish = editor.locator('[data-reparcel-finish]');
    await line.click();
    await expect(line).toHaveAttribute('aria-pressed', 'true');
    await expect(finish).toHaveText('Finish line (F)');
    const [start, end] = await crossingLine(page);
    await page.mouse.click(start.x, start.y);
    await expect(finish).toBeDisabled();
    await page.mouse.click(end.x, end.y);
    await expect(finish).toBeEnabled();
    await finish.click();
    await expect.poll(() => rows(editor).count()).toBeGreaterThan(2);
    await expect(status(editor)).toContainText('Line drawn');
    await expect(line).toHaveAttribute('aria-pressed', 'false');
  });

  test('Erase a boundary merges the two plots it separates and clears its map target', async ({ mockApi: page }) => {
    const editor = await openLayoutEditor(page);
    await option(editor, 'manual').click();
    await expect(rows(editor)).toHaveCount(2);
    const erase = editor.locator('[data-reparcel-erase]');
    await erase.click();
    await expect(erase).toHaveAttribute('aria-pressed', 'true');
    const lines = page.locator('#map-container path.reparcel-erase-line');
    // The one boundary and its wide invisible halo.
    await expect(lines).toHaveCount(2);
    await expect(status(editor)).toContainText('1 boundaries can be erased');
    const target = await eraseTarget(page);
    await page.mouse.click(target.x, target.y);
    await expect(rows(editor)).toHaveCount(1);
    await expect(lines).toHaveCount(0);
    await expect(status(editor)).toContainText('There are no boundaries between plots here');
    await erase.click();
    await expect(erase).toHaveAttribute('aria-pressed', 'false');
  });

  test('Edit boundaries toggles the handles, Remove node dissolves a cut, and Undo restores it', async ({ mockApi: page }) => {
    test.setTimeout(90_000);
    const editor = await openLayoutEditor(page);
    await option(editor, 'manual').click();
    const nodes = editor.locator('[data-reparcel-nodes]');
    const handles = page.locator('#map-container .reparcel-node-handle');
    await expect(nodes).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => handles.count()).toBeGreaterThan(0);
    await nodes.click();
    await expect(nodes).toHaveAttribute('aria-pressed', 'false');
    await expect(handles).toHaveCount(0);
    await nodes.click();
    await expect(nodes).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => handles.count()).toBeGreaterThan(0);

    // Draw freely starts from the equal split: erase its boundary so the cut below is the only one.
    await editor.locator('[data-reparcel-erase]').click();
    const boundary = await eraseTarget(page);
    await page.mouse.click(boundary.x, boundary.y);
    await expect(rows(editor)).toHaveCount(1);
    await editor.locator('[data-reparcel-erase]').click();
    await expect(nodes).toHaveAttribute('aria-pressed', 'true');

    await editor.locator('[data-reparcel-line]').click();
    for (const end of await crossingLine(page)) await page.mouse.click(end.x, end.y);
    await editor.locator('[data-reparcel-finish]').click();
    await expect(rows(editor)).toHaveCount(2);
    // The cut's two ends, where it meets the pooled outline, are the nodes that can be acted on.
    await expect(handles).toHaveCount(2);
    const plots = page.locator('#map-container .leaflet-reparcelPlots-pane path.leaflet-interactive');
    const cutGeometry = await plots.evaluateAll(elements => elements.map(element => element.getAttribute('d')));

    await handles.first().click();
    const popup = page.locator('.reparcel-node-popup');
    await expect(popup).toBeVisible();
    await popup.getByRole('button', { name: 'Remove node', exact: true }).click();
    await expect(rows(editor)).toHaveCount(1);
    await expect.poll(() => handles.count()).toBeLessThan(2);

    const undo = editor.locator('[data-reparcel-undo-edit]');
    await expect(undo).toBeEnabled();
    await undo.click();
    await expect(rows(editor)).toHaveCount(2);
    await expect(handles).toHaveCount(2);
    await expect.poll(() => plots.evaluateAll(elements => elements.map(element => element.getAttribute('d')))).toEqual(cutGeometry);
    // The cut itself is still in the history.
    await expect(undo).toBeEnabled();
  });

  test('Undo and Redo walk the edit history and start with nothing to undo', async ({ mockApi: page }) => {
    const editor = await openLayoutEditor(page);
    const undo = editor.locator('[data-reparcel-undo-edit]');
    const redo = editor.locator('[data-reparcel-redo-edit]');
    const count = editor.locator('[data-parcel-layout-count]');
    await expect(undo).toBeDisabled();
    await expect(redo).toBeDisabled();
    const equal = await rows(editor).allInnerTexts();
    expect(equal).toHaveLength(2);

    await setPlotCount(editor, 3);
    await expect(rows(editor)).toHaveCount(3);
    await expect(undo).toBeEnabled();
    await expect(redo).toBeDisabled();

    await undo.click();
    await expect(rows(editor)).toHaveCount(2);
    await expect(count).toHaveValue('2');
    expect(await rows(editor).allInnerTexts()).toEqual(equal);
    await expect(status(editor)).toHaveText('Undid the last change.');
    await expect(undo).toBeDisabled();
    await expect(redo).toBeEnabled();

    await redo.click();
    await expect(rows(editor)).toHaveCount(3);
    await expect(count).toHaveValue('3');
    await expect(status(editor)).toHaveText('Redid the change.');
    await expect(redo).toBeDisabled();
    await expect(undo).toBeEnabled();
  });

  test('Upload GeoJSON replaces the layout with the file\'s plots, as one undo step', async ({ mockApi: page }) => {
    const editor = await openLayoutEditor(page);
    await expect(rows(editor)).toHaveCount(2);
    const equal = await rows(editor).allInnerTexts();
    await editor.locator('[data-reparcel-upload]').setInputFiles({
      name: 'two-plots.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify(TWO_PLOTS)),
    });
    await expect(status(editor)).toHaveText('Loaded 2 polygons from file.');
    // An imported layout is drawn, not generated.
    await expect(editor.locator('input[name="reparcel-algorithm"][value="manual"]')).toBeChecked();
    await expect(rows(editor)).toHaveCount(2);
    await expect.poll(() => rows(editor).allInnerTexts()).not.toEqual(equal);

    await editor.locator('[data-reparcel-undo-edit]').click();
    await expect(editor.locator('input[name="reparcel-algorithm"][value="equal"]')).toBeChecked();
    await expect.poll(() => rows(editor).allInnerTexts()).toEqual(equal);
  });

  test('Before / after compares the plots with the parcel they replace, and an edit ends the comparison', async ({ mockApi: page }) => {
    const editor = await openLayoutEditor(page);
    const compare = editor.locator('[data-reparcel-compare]');
    const beforeMap = page.locator('#map .map-compare__before');
    await expect(compare).toBeVisible();
    await expect(compare).toHaveAttribute('aria-pressed', 'false');
    await compare.click();
    await expect(compare).toHaveAttribute('aria-pressed', 'true');
    await expect(beforeMap).toBeVisible();
    await expect(page.locator('#map .map-compare__label--before')).toContainText('Before');
    await expect(page.locator('#map .map-compare__label--after')).toContainText('After');

    await setPlotCount(editor, 3);
    await expect(rows(editor)).toHaveCount(3);
    await expect(compare).toHaveAttribute('aria-pressed', 'false');
    await expect(beforeMap).toHaveCount(0);

    await compare.click();
    await expect(beforeMap).toBeVisible();
    await compare.click();
    await expect(compare).toHaveAttribute('aria-pressed', 'false');
    await expect(beforeMap).toHaveCount(0);
  });

  test('From a building block carves the chosen block\'s courtyard out as a plot of its own', async ({ mockApi: page }) => {
    const editor = await openLayoutEditor(page);
    const courtyardTools = editor.locator('[data-reparcel-courtyard-tools]');
    await expect(courtyardTools).toBeHidden();
    await option(editor, 'amend').click();
    await expect(rows(editor)).toHaveCount(1);
    await expect(courtyardTools).toBeVisible();
    const fromBlock = editor.locator('[data-reparcel-courtyard-building]');
    await expect(fromBlock).toHaveText('From a building block');

    // No planned building block encloses a courtyard here yet: the tool says so and changes nothing.
    await fromBlock.click();
    await expect(status(editor)).toHaveText('No building block with an enclosed courtyard overlaps these parcels.');
    await expect(rows(editor)).toHaveCount(1);

    await page.evaluate(parcelId => {
      const ring = [[15.9819, 45.8], [15.9825, 45.8], [15.9825, 45.8005], [15.9819, 45.8005], [15.9819, 45.8]];
      const hole = [[15.9821, 45.8001], [15.9823, 45.8001], [15.9823, 45.8003], [15.9821, 45.8003], [15.9821, 45.8001]];
      for (const title of ['Courtyard candidate A', 'Courtyard candidate B']) {
        (window as any).proposalStorage.addProposal({
          title, goal: 'buildings', primaryType: 'Building', cadastreParcelIds: [parcelId], applied: false,
          buildingProposal: { parameters: { mode: 'block' } },
          geometry: { ruleMassing: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring, hole.slice().reverse()] } } },
        });
      }
    }, PARCEL_ID);
    await fromBlock.click();
    const chooser = page.locator('.reparcel-owner-popup');
    await expect(chooser).toContainText('Choose a building block');
    await expect(chooser.getByRole('button', { name: 'Courtyard candidate A' })).toBeVisible();
    await chooser.getByRole('button', { name: 'Courtyard candidate B' }).click();
    await expect(chooser).toHaveCount(0);
    await expect(status(editor)).toHaveText('Courtyard carved out as a plot of its own.');
    await expect(rows(editor)).toHaveCount(2);

    await editor.locator('[data-reparcel-commit]').click();
    await expect(editor).toHaveCount(0);
    const layout = await appliedLayout(page);
    expect(layout.parcelLayout.algorithm).toBe('amend');
    expect(layout.parcelLayout.inputParcels.map((input: any) => input.parcelId)).toEqual([PARCEL_ID]);
    const courtyard = layout.parcelLayout.plots.find((plot: any) => plot.source === 'form');
    expect(courtyard?.derivation).toMatchObject({ kind: 'building-courtyard', sourceTitle: 'Courtyard candidate B' });
  });
});
