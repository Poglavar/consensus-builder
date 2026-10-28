// Purpose: the parcel-layout editor ("Lay out parcels") from the Build palette to the map: its starting
// layouts and hand edits shape the plots, and Done applies them as a parcel layout whose live pieces
// keep their plot references and are held by the owners of the ground under them.
import { test, expect } from '../helpers/fixtures';
import { clickMapPoint, openCity, openParcel, showProposal, PARCEL_ID, closeParcel, showSelectionDesignTab } from '../helpers/runtime';
import { sampleParcels } from '../helpers/mocks/parcel-data';
import { editorOpen, editorClosed, editorCancel } from '../helpers/agreements';
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

// The Build palette of parcel 1234, then its Lay out parcels tile.
async function openLayoutEditor(page: Page): Promise<Locator> {
  await openCity(page);
  await page.evaluate(() => (window as any).i18n.setLanguage('en'));
  await openParcel(page, 'proposals');
  await page.locator('.parcel-build-btn--parcel-layout').click();
  return editorReady(page);
}

// Rows of the New plots list: "1 1,295 m²".
async function plotRows(editor: Locator): Promise<string[]> {
  return editor.locator('[data-reparcel-newplots-table] tbody tr').evaluateAll(rows => rows
    .map(row => (row as HTMLElement).innerText.replace(/\s+/g, ' ').trim()).filter(Boolean));
}

const algorithm = (editor: Locator) => editor.locator('input[name="reparcel-algorithm"]:checked').inputValue();
const chooseLayout = (editor: Locator, value: string) => editor.locator(`label.reparcel-alg-option:has(input[value="${value}"])`).click();

// The one applied parcel layout, as stored.
async function appliedLayout(page: Page): Promise<any> {
  await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals()
    .filter((proposal: any) => proposal.applied && proposal.goal === 'parcel-layout').length)).toBe(1);
  return page.evaluate(() => JSON.parse(JSON.stringify((window as any).proposalStorage.getAllProposals()
    .find((proposal: any) => proposal.applied && proposal.goal === 'parcel-layout'))));
}

// A point on the first draggable boundary segment, in page coordinates, where the segment itself is
// what the pointer lands on: its midpoint has the insert handle and a node or the sweep handle can
// sit over it elsewhere.
async function segmentPoint(page: Page): Promise<{ x: number; y: number }> {
  return page.locator('path.geom-handle-edge').first().evaluate(element => {
    const path = element as unknown as SVGPathElement;
    const matrix = path.getScreenCTM()!;
    for (const fraction of [0.3, 0.7, 0.2, 0.8, 0.4, 0.6]) {
      const point = path.getPointAtLength(path.getTotalLength() * fraction);
      const screen = { x: point.x * matrix.a + point.y * matrix.c + matrix.e, y: point.x * matrix.b + point.y * matrix.d + matrix.f };
      if (document.elementFromPoint(screen.x, screen.y) === path) return screen;
    }
    throw new Error('Every point tried on the boundary segment is covered by a handle');
  });
}

async function unobstructedHandlePoint(locator: Locator): Promise<{ x: number; y: number }> {
  return locator.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    if (document.elementFromPoint(point.x, point.y) !== element) {
      throw new Error(`Handle ${element.className} is covered at its center`);
    }
    return point;
  });
}

async function handleOpacity(locator: Locator): Promise<string> {
  return locator.evaluate(element => getComputedStyle(element).opacity);
}

async function attachEditorScreenshot(page: Page, testInfo: import('@playwright/test').TestInfo, name: string) {
  const path = testInfo.outputPath(name);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

// The ends of an east-west line across the pool (the red outline), just outside it on both sides and
// clear of the editor's panels. Equal plots are cut north-south, so this line crosses them all.
async function crossingLine(page: Page): Promise<Array<{ x: number; y: number }>> {
  return page.evaluate(() => {
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
    const screenOf = (lng: number, lat: number) => {
      const point = map.latLngToContainerPoint([lat, lng]);
      return { x: mapRect.left + point.x, y: mapRect.top + point.y };
    };
    const clear = (p: { x: number; y: number }) => p.x >= mapRect.left + 8 && p.x <= mapRect.right - 8
      && p.y >= mapRect.top + 8 && p.y <= mapRect.bottom - 8
      && map.getContainer().contains(document.elementFromPoint(p.x, p.y))
      && !obstacles.some(rect => p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom);
    for (const ratio of [0.5, 0.4, 0.6, 0.3, 0.7]) {
      const lat = minLat + (maxLat - minLat) * ratio;
      for (const extension of [0.08, 0.04, 0.02]) {
        const ends = [screenOf(minLng - (maxLng - minLng) * extension, lat), screenOf(maxLng + (maxLng - minLng) * extension, lat)];
        if (ends.every(clear)) return ends;
      }
    }
    throw new Error('No line across the pool fits the unobstructed map area');
  });
}

test('the Build tile opens the editor on equal plots, and the plot count sets how many plots Done applies', async ({ mockApi: page }) => {
  const editor = await openLayoutEditor(page);
  await expect(editor.locator('.on-map-editor__heading h2')).toHaveText('Lay out parcels');
  expect(await algorithm(editor)).toBe('equal');
  const count = editor.locator('[data-parcel-layout-count]');
  // One parcel starts at the smallest count: two plots, numbered on the map as in the list.
  await expect(count).toHaveValue('2');
  await expect.poll(async () => (await plotRows(editor)).length).toBe(2);
  await expect(page.locator('.reparcel-plot-number')).toHaveCount(2);

  await count.fill('4');
  await count.press('Enter');
  await expect.poll(async () => (await plotRows(editor)).length).toBe(4);
  await expect(page.locator('.reparcel-plot-number')).toHaveCount(4);
  // Below the smallest count the field comes back to it.
  await count.fill('1');
  await count.press('Enter');
  await expect(count).toHaveValue('2');
  await expect.poll(async () => (await plotRows(editor)).length).toBe(2);
  await count.fill('4');
  await count.press('Enter');
  await expect.poll(async () => (await plotRows(editor)).length).toBe(4);
  await expect(editor.locator('[data-reparcel-coverage]')).toContainText('The plots cover the whole pool');

  await editor.locator('[data-reparcel-commit]').click();
  await expect(editor).toHaveCount(0);
  const layout = await appliedLayout(page);
  expect(layout.primaryType).toBe('ParcelLayout');
  expect(layout.title).toMatch(/parcel layout/i);
  expect(layout.cadastreParcelIds).toContain(PARCEL_ID);
  expect(layout.parcelLayout).toMatchObject({ algorithm: 'equal', plotCount: 4 });
  expect(layout.parcelLayout.plots).toHaveLength(4);
  expect(layout.parcelLayout.plots.every((plot: any) => plot.source === 'equal')).toBe(true);
  const total = layout.parcelLayout.plots.reduce((sum: number, plot: any) => sum + plot.area, 0);
  for (const plot of layout.parcelLayout.plots) expect(plot.area / total).toBeCloseTo(0.25, 2);
  // A layout draws borders only: who gets which plot, and on what terms, is its agreement's business.
  expect(JSON.stringify(layout.parcelLayout)).not.toMatch(/owner|share|cash|offer|budget|currency|approval/i);
  expect(layout.approvalConfig).toBeUndefined();
});

test('Schelling plots lay the plan out with the Schelling layer\'s own settings', async ({ mockApi: page }) => {
  // The settings the Schelling layer remembers for this viewer (schelling-layer.js): 14 m local
  // streets instead of the default 12, so the plan code shows which settings were used.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('cb.schelling.settings', JSON.stringify({ targetBlockM: 120, streetWidthM: 14, plotLevel: 3 }));
    } catch (_) { /* opaque origin */ }
  });
  const editor = await openLayoutEditor(page);
  const schelling = editor.locator('input[name="reparcel-algorithm"][value="schelling"]');
  await expect(schelling).toBeEnabled();
  await chooseLayout(editor, 'schelling');
  await expect(schelling).toBeChecked();
  await expect(editor.locator('[data-reparcel-status]')).toContainText(/Plots of Schelling plan \S+-14@46N\./);
  // The count belongs to equal plots.
  await expect(editor.locator('[data-parcel-layout-count-field]')).toBeHidden();
  await expect.poll(async () => (await plotRows(editor)).length).toBeGreaterThan(0);
  await expect(editor.locator('[data-reparcel-commit]')).toBeEnabled();

  await editor.locator('[data-reparcel-commit]').click();
  await expect(editor).toHaveCount(0);
  const layout = await appliedLayout(page);
  expect(layout.parcelLayout.algorithm).toBe('schelling');
  expect(layout.parcelLayout.schelling.code).toMatch(/-14@46N$/);
  expect(layout.parcelLayout.plotCount).toBeUndefined();
  expect(layout.parcelLayout.plots.length).toBeGreaterThan(0);
  expect(layout.parcelLayout.plots.every((plot: any) => ['schelling', 'schelling-remainder'].includes(plot.source))).toBe(true);
});

test('a boundary segment drags straight away, undo and redo walk it back and forth, Draw freely keeps the plots', async ({ mockApi: page }) => {
  test.setTimeout(90_000);
  const editor = await openLayoutEditor(page);
  // The handles are the editor: on from the start, with grabbable segments between plots.
  await expect(editor.locator('[data-reparcel-nodes]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('path.geom-handle-edge').first()).toBeAttached();
  await expect(page.locator('.reparcel-plot-number').first()).toBeVisible();
  const equal = await plotRows(editor);
  expect(equal).toHaveLength(2);

  const start = await segmentPoint(page);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) await page.mouse.move(start.x + step * 4, start.y);
  await page.mouse.up();

  await expect.poll(() => plotRows(editor)).not.toEqual(equal);
  const dragged = await plotRows(editor);
  expect(dragged).toHaveLength(equal.length);
  // Editing the equal plots turned them into a drawn layout.
  expect(await algorithm(editor)).toBe('manual');

  await page.mouse.move(5, 400);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => plotRows(editor)).toEqual(equal);
  expect(await algorithm(editor)).toBe('equal');
  await expect(editor.locator('[data-reparcel-redo-edit]')).toBeEnabled();

  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => plotRows(editor)).toEqual(dragged);
  expect(await algorithm(editor)).toBe('manual');

  // Back to equal plots, then Draw freely: the plots on the map come along.
  await chooseLayout(editor, 'equal');
  await expect.poll(() => plotRows(editor)).toEqual(equal);
  await chooseLayout(editor, 'manual');
  await expect.poll(() => algorithm(editor)).toBe('manual');
  expect(await plotRows(editor)).toEqual(equal);
  await expect(editor.locator('[data-reparcel-status]')).toContainText('Drawing freely from the current layout');
});

test('editing handles appear on hover and hide again on desktop', async ({ mockApi: page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  const editor = await openLayoutEditor(page);
  const node = page.locator('#map-container .reparcel-node-handle').first();
  const midpoint = page.locator('#map-container .reparcel-edge-handle').first();
  const sweep = page.locator('#map-container .reparcel-sweep-handle');
  const edge = page.locator('#map-container path.geom-handle-edge').first();

  await expect(node).toBeAttached();
  await expect(midpoint).toBeAttached();
  await expect(sweep).toBeAttached();
  await expect.poll(() => handleOpacity(node)).toBe('0');
  await expect.poll(() => handleOpacity(midpoint)).toBe('0');
  await expect.poll(() => handleOpacity(sweep)).toBe('0');
  await attachEditorScreenshot(page, testInfo, 'parcel-layout-handles-hidden.png');

  for (const handle of [node, midpoint, sweep]) {
    const point = await unobstructedHandlePoint(handle);
    await page.mouse.move(point.x, point.y);
    await expect.poll(() => handleOpacity(handle)).toBe('1');
    await page.mouse.move(5, 400);
    await expect.poll(() => handleOpacity(handle)).toBe('0');
  }

  const segment = await segmentPoint(page);
  await page.mouse.move(segment.x, segment.y);
  await expect.poll(() => edge.evaluate(element => getComputedStyle(element).strokeOpacity)).toBe('0.35');
  await page.mouse.move(5, 400);
  await expect.poll(() => handleOpacity(node)).toBe('0');
  await expect.poll(() => handleOpacity(midpoint)).toBe('0');
  await expect.poll(() => handleOpacity(sweep)).toBe('0');
  await page.evaluate(() => {
    const map=(window as any).map;
    map.setZoom(map.getZoom()-3,{animate:false});
  });
  for(const handle of [node,midpoint,sweep])await expect.poll(()=>handleOpacity(handle)).toBe('0');
  await expect(editor.locator('.on-map-editor__panel')).toBeVisible();
});

test.describe('touch parcel layout handles', () => {
  test.use({ viewport: { width: 1280, height: 860 }, hasTouch: true });

  test('keeps node, midpoint, and sweep handles visible and opens a node popup on tap', async ({ mockApi: page }) => {
    const editor = await openLayoutEditor(page);
    const node = page.locator('#map-container .reparcel-node-handle').first();
    const midpoint = page.locator('#map-container .reparcel-edge-handle').first();
    const sweep = page.locator('#map-container .reparcel-sweep-handle');
    for (const handle of [node, midpoint, sweep]) {
      await expect(handle).toBeVisible();
      await expect.poll(() => handleOpacity(handle)).toBe('1');
    }

    const point = await unobstructedHandlePoint(node);
    await page.touchscreen.tap(point.x, point.y);
    await expect(page.locator('.leaflet-popup .reparcel-node-popup')).toBeVisible();
    await expect(editor.locator('.on-map-editor__panel')).toBeVisible();
  });
});

test('a click on a boundary offers to erase it, and Delete removes a node from its popup', async ({ mockApi: page }) => {
  test.setTimeout(90_000);
  const editor = await openLayoutEditor(page);
  const before = await plotRows(editor);
  expect(before).toHaveLength(2);

  const point = await segmentPoint(page);
  await page.mouse.click(point.x, point.y);
  const popup = page.locator('.leaflet-popup .reparcel-node-popup');
  await expect(popup).toContainText('Boundary between plot 1');
  await page.keyboard.press('Escape');
  await expect(popup).toHaveCount(0);
  // Escape closed only the popup, not the editor.
  await expect(editor.locator('.on-map-editor__panel')).toBeVisible();

  await page.mouse.click(point.x, point.y);
  await popup.getByRole('button', { name: 'Erase this boundary' }).click();
  await expect.poll(async () => (await plotRows(editor)).length).toBe(before.length - 1);
  await expect(editor.locator('[data-reparcel-status]')).toContainText('Boundary erased');

  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => plotRows(editor)).toEqual(before);

  // A node popup: Delete removes the node, which dissolves the boundary it ends.
  const node = page.locator('.reparcel-node-handle').first();
  await node.click();
  await expect(popup).toBeVisible();
  await expect(popup.getByRole('button', { name: 'Remove node' })).toBeVisible();
  await page.keyboard.press('Delete');
  await expect(popup).toHaveCount(0);
  await expect.poll(() => plotRows(editor)).not.toEqual(before);
});

test('a line cuts the plots it crosses, a GeoJSON file replaces the layout, and Before / after compares it', async ({ mockApi: page }) => {
  test.setTimeout(90_000);
  const editor = await openLayoutEditor(page);
  // Draw freely keeps the two equal plots and takes the sweep handle off the map.
  await chooseLayout(editor, 'manual');
  await expect.poll(() => algorithm(editor)).toBe('manual');
  await expect.poll(async () => (await plotRows(editor)).length).toBe(2);

  const line = editor.locator('[data-reparcel-line]');
  await line.click();
  await expect(line).toHaveAttribute('aria-pressed', 'true');
  const finish = editor.locator('[data-reparcel-finish]');
  await expect(finish).toHaveText('Finish line (F)');
  await expect(finish).toBeDisabled();
  for (const end of await crossingLine(page)) await page.mouse.click(end.x, end.y);
  await expect(finish).toBeEnabled();
  await finish.click();
  await expect.poll(async () => (await plotRows(editor)).length).toBeGreaterThan(2);
  await expect(editor.locator('[data-reparcel-status]')).toContainText('Line drawn');
  await expect(line).toHaveAttribute('aria-pressed', 'false');

  await editor.locator('[data-reparcel-upload]').setInputFiles({
    name: 'two-plots.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify(TWO_PLOTS)),
  });
  await expect(editor.locator('[data-reparcel-status]')).toHaveText('Loaded 2 polygons from file.');
  await expect.poll(async () => (await plotRows(editor)).length).toBe(2);

  const compare = editor.locator('[data-reparcel-compare]');
  await compare.click();
  await expect(compare).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#map .map-compare__before')).toBeVisible();
  await compare.click();
  await expect(compare).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#map .map-compare__before')).toHaveCount(0);

  await editor.locator('[data-reparcel-commit]').click();
  await expect(editor).toHaveCount(0);
  const layout = await appliedLayout(page);
  expect(layout.parcelLayout.algorithm).toBe('manual');
  expect(layout.parcelLayout.plots.map((plot: any) => plot.source)).toEqual(['geojson', 'geojson']);
});

// The import limit is 1,000 polygons (parcel-layout-validation.js MAX_PLOTS); exactly that many,
// a 40 × 25 grid over parcel 1234, used to stall the editor (N1, 2026-10-28 retest).
function gridPlots(cols: number, rows: number) {
  const [west, south, east, north] = [15.9819, 45.8, 15.9825, 45.8005];
  const dx = (east - west) / cols, dy = (north - south) / rows;
  const features = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = west + c * dx, y = south + r * dy;
    features.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[x, y], [x + dx, y], [x + dx, y + dy], [x, y + dy], [x, y]]] } });
  }
  return { type: 'FeatureCollection', features };
}

test('a file of exactly 1,000 plots imports, and Done applies all of them', async ({ mockApi: page }) => {
  test.setTimeout(180_000);
  const editor = await openLayoutEditor(page);
  const started = Date.now();
  await editor.locator('[data-reparcel-upload]').setInputFiles({
    name: 'grid-1000.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify(gridPlots(40, 25))),
  });
  await expect(editor.locator('[data-reparcel-status]')).toHaveText('Loaded 1000 polygons from file.', { timeout: 60_000 });
  const importMs = Date.now() - started;
  await expect(editor.locator('[data-reparcel-newplots-table] tbody tr')).toHaveCount(1000);
  test.info().annotations.push({ type: 'import-ms', description: String(importMs) });
  const committed = Date.now();
  await editor.locator('[data-reparcel-commit]').click();
  await expect(editor).toHaveCount(0, { timeout: 90_000 });
  const layout = await appliedLayout(page);
  expect(layout.parcelLayout.plots).toHaveLength(1000);
  test.info().annotations.push({ type: 'apply-ms', description: String(Date.now() - committed) });
});

test('Done applies the plots, and every live piece keeps its authored plot reference through a reload', async ({ mockApi: page }) => {
  const editor = await openLayoutEditor(page);
  await editor.locator('[data-reparcel-commit]').click();
  await expect(editor).toHaveCount(0);
  const { proposalId } = await appliedLayout(page);
  const references = () => page.evaluate(id => {
    const w = window as any;
    const proposal = w.proposalStorage.getProposal(id);
    return {
      authored: proposal.parcelLayout.plots.map((plot: any) => w.ParcelLayoutRecord.plotFingerprint(plot)).sort(),
      materialized: w.LiveParcelFabric.producedBy(id).filter((piece: any) => piece.properties.readjustmentPiece?.role === 'plot')
        .map((piece: any) => piece.properties.readjustmentPiece.plotFingerprint).sort(),
      authoredHasRuntimeMetadata: proposal.parcelLayout.plots.some((plot: any) => plot.readjustmentPiece != null)
    };
  }, proposalId);
  const before = await references();
  expect(before.authored).toHaveLength(2);
  expect(before.authored.every((fingerprint: string) => fingerprint.startsWith('layout-plot1-sha256:'))).toBe(true);
  expect(before.materialized).toEqual(before.authored);
  expect(before.authoredHasRuntimeMetadata).toBe(false);

  const pieceId = await page.evaluate(id => {
    const w = window as any;
    const feature = w.LiveParcelFabric.producedBy(id).find((piece: any) => piece.properties.readjustmentPiece?.role === 'plot');
    w.hideProposalDetailsPanel();
    // A plot piece is formed ground: the click stack names it without expanding, so its inspector
    // opens through the parcel commands' Details runner.
    w.ParcelMenu.runAction('details', w.ParcelMenu.factsFor(feature.properties.parcelId, feature));
    return feature.properties.parcelId;
  }, proposalId);
  await expect(page.locator('#parcel-info-title')).toHaveText(`Plot piece ${pieceId}`);
  await expect(page.locator('#info-content [role="note"]')).toContainText('Ground derived from one authored parcel-layout plot');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window as any).ProposalManager?._initialReapplyDone === true);
  expect(await references()).toEqual(before);
});

// Parcels 1234 and 1235 as neighbours sharing the border at 15.9823, each with its own owner.
const ADJACENT_IDS = ['HR-335754-1234', 'HR-335754-1235'];
const ring = (west: number, south: number, east: number, north: number) =>
  [[west, south], [east, south], [east, north], [west, north], [west, south]];
const ADJACENT_PARCELS = {
  type: 'FeatureCollection',
  features: ADJACENT_IDS.map((id, index) => ({
    type: 'Feature',
    properties: {
      ...sampleParcels.features[0].properties, parcelId: id, parcel_id: id, id,
      parcel_number: String(1234 + index), BROJ_CESTICE: String(1234 + index),
    },
    geometry: { type: 'Polygon', coordinates: [index ? ring(15.9823, 45.8, 15.9825, 45.8005) : ring(15.9819, 45.8, 15.9823, 45.8005)] },
  })),
};

test('a plot laid across two owners\' parcels is held jointly by both, pro rata by area', async ({ mockApi: page }) => {
  test.setTimeout(90_000);
  await page.route('**/parcels**', route => {
    if (!['fetch', 'xhr'].includes(route.request().resourceType())) return route.fallback();
    return route.fulfill({ json: ADJACENT_PARCELS });
  });
  await openCity(page);
  // The modelled owner of each parcel, the record a layout carries over to the pieces it forms.
  const owners = await page.evaluate(async ids => {
    const w = window as any;
    await w.i18n.setLanguage('en');
    await w.CadastralParcelRepository.ensureIds(ids);
    w.map.setView([45.80025, 15.9822], 19, { animate: false });
    return ids.map((parcelId: string, index: number) => {
      const agent = w.createAgent();
      agent.name = `Layout owner ${index ? 'B' : 'A'}`;
      w.agentStorage.addAgent(agent);
      w.PersistentStorage.setItem(`parcel_${parcelId}_owner`, agent.id);
      return { id: String(agent.id), name: String(agent.name) };
    });
  }, ADJACENT_IDS);
  await expect.poll(() => page.evaluate(ids => ids.every((id: string) => !!(window as any).LiveParcelFabric.get(id)), ADJACENT_IDS)).toBe(true);

  // Both parcels selected, then laid out from the selection's palette.
  await openParcel(page);
  await page.locator('#parcel-manual-selection').click();
  await closeParcel(page);
  await clickMapPoint(page, 15.9824, 45.80025);
  await expect.poll(() => page.evaluate(() => [...(window as any).multiParcelSelection.selectedParcels].sort())).toEqual(ADJACENT_IDS);
  await showSelectionDesignTab(page);
  await expect(page.locator('.parcel-build-palette')).toBeVisible();
  await page.locator('.parcel-build-btn--parcel-layout').click();
  const editor = await editorReady(page);
  // Two equal plots over parcels of unequal width: at least one of them crosses the shared border.
  await expect.poll(async () => (await plotRows(editor)).length).toBe(2);
  await editor.locator('[data-reparcel-commit]').click();
  await expect(editor).toHaveCount(0);
  const { proposalId } = await appliedLayout(page);

  const pieces = await page.evaluate(id => {
    const w = window as any;
    return w.LiveParcelFabric.producedBy(id)
      .filter((piece: any) => piece.properties.readjustmentPiece?.role === 'plot')
      .map((piece: any) => {
        const holderId = w.PersistentStorage.getItem(`parcel_${piece.properties.parcelId}_owner`);
        const holder = holderId ? w.agentStorage.getAgent(holderId) : null;
        return {
          joint: piece.properties.jointPool === true,
          owners: (piece.properties.ownershipDetails?.owners || []).map((owner: any) => ({ name: String(owner.name), percent: Number(owner.percentageShare) })),
          holderId: holderId ? String(holderId) : null,
          holderIsJoint: holder?.jointPool === true,
          members: (holder?.members || []).map((member: any) => ({ agentId: String(member.agentId), share: Number(member.share) }))
        };
      });
  }, proposalId);
  expect(pieces.length).toBeGreaterThanOrEqual(2);
  const joint = pieces.filter((piece: any) => piece.joint);
  expect(joint.length, 'a plot across the border must be a joint holding').toBeGreaterThan(0);
  for (const piece of joint) {
    expect(piece.owners.map((owner: any) => owner.name).sort()).toEqual(['Layout owner A', 'Layout owner B']);
    expect(piece.owners.reduce((sum: number, owner: any) => sum + owner.percent, 0)).toBeCloseTo(100, 6);
    // The piece's owner record is one joint holder whose members are the two owners.
    expect(piece.holderIsJoint).toBe(true);
    expect(piece.members.map((member: any) => member.agentId).sort()).toEqual(owners.map(owner => owner.id).sort());
    expect(piece.members.reduce((sum: number, member: any) => sum + member.share, 0)).toBeCloseTo(1, 6);
  }
  // A plot inside one parcel stays with that parcel's owner alone.
  for (const piece of pieces.filter((entry: any) => !entry.joint)) {
    expect(piece.owners).toHaveLength(1);
    expect(owners.map(owner => owner.id)).toContain(piece.holderId);
  }
});

test('a parcel layout\'s details offer no sharing or duplicate: it is published with its agreement', async ({ mockApi: page }) => {
  const editor = await openLayoutEditor(page);
  await editor.locator('[data-reparcel-commit]').click();
  await expect(editor).toHaveCount(0);
  const { proposalId } = await appliedLayout(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await showProposal(page, proposalId);
  const panel = page.locator('#proposal-details-panel');
  const share = panel.locator('.btn-share-proposal');
  await expect(share).toHaveCount(1);
  await expect(share).toBeDisabled();
  await expect(share).toHaveAttribute('aria-describedby', 'proposal-publish-later-note');
  await expect(panel.locator('#proposal-publish-later-note')).toHaveText('A parcel layout is published with its agreement. Propose an agreement that includes it.');
  await expect(panel.locator('.btn-duplicate-design')).toHaveCount(0);
  const actionGrid = panel.locator('.proposal-primary-actions');
  const layout = await actionGrid.evaluate(grid => {
    const buttons = [...grid.querySelectorAll<HTMLElement>(':scope > button')].filter(button => getComputedStyle(button).display !== 'none');
    const note = grid.querySelector<HTMLElement>('.proposal-publish-later')!;
    const gridRect = grid.getBoundingClientRect(), noteRect = note.getBoundingClientRect();
    const buttonRects = buttons.map(button => button.getBoundingClientRect());
    const panelRect = document.querySelector('#proposal-details-panel')!.getBoundingClientRect();
    const footerRect = grid.closest('.panel-footer')!.getBoundingClientRect();
    return { columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
      heights: buttonRects.map(rect => rect.height), buttonBottom: Math.max(...buttonRects.map(rect => rect.bottom)),
      gridLeft: gridRect.left, gridWidth: gridRect.width, noteLeft: noteRect.left, noteWidth: noteRect.width,
      noteTop: noteRect.top, noteBottom: noteRect.bottom, panelBottom: panelRect.bottom, footerBottom: footerRect.bottom };
  });
  expect(layout.columns).toBe(2);
  expect(layout.heights.length).toBeGreaterThanOrEqual(4);
  expect(layout.heights.every(height => height <= 56)).toBe(true);
  expect(layout.noteTop).toBeGreaterThanOrEqual(layout.buttonBottom);
  expect(Math.abs(layout.noteLeft - layout.gridLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.noteWidth - layout.gridWidth)).toBeLessThanOrEqual(1);
  expect(layout.noteBottom).toBeLessThanOrEqual(layout.footerBottom);
  expect(layout.footerBottom).toBeLessThanOrEqual(layout.panelBottom);
  // Nobody decides on or bets on a design by itself (M3): only an agreement over it is minted and bet on.
  await expect(panel.getByRole('button', { name: /\bbet\b/i })).toHaveCount(0);
  // What it offers instead: Add to agreement, the layout's main action, which opens the agreement
  // editor over it.
  const add = panel.locator('.btn-create-agreement');
  await expect(add).toHaveClass(/\bbtn-primary\b/);
  await expect(add).toHaveText('Add to agreement');
  await add.click();
  const agreementEditor = await editorOpen(page, 'Create agreement');
  await expect(agreementEditor.locator(`input[data-agreement-design="${proposalId}"]`)).toBeChecked();
  await editorCancel(agreementEditor).click();
  await editorClosed(page);
});
