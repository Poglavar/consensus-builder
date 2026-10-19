// Purpose: cover the standalone OSM block browser's list/details navigation and the legacy parcel
// block inspector tabs through their real entry paths and visible state changes.
import { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, expectStatusLogged } from '../helpers/runtime';
import { installLayerDatasets } from '../helpers/mocks/layer-datasets';
import { selectNativeOption } from '../helpers/controls';

async function serveClosedBlocks(page: Page): Promise<string[]> {
  const requests: string[] = [];
  const [lat, lon] = await page.evaluate(() => {
    const center = (window as any).map.getCenter();
    return [center.lat, center.lng];
  });
  const d = 0.001;
  const way = (id: string, coordinates: number[][]) => ({
    type: 'Feature', id,
    properties: { highway: 'residential', name: `Street ${id}` },
    geometry: { type: 'LineString', coordinates },
  });
  const square = [
    way('south', [[lon - d, lat - d], [lon + d, lat - d]]),
    way('east', [[lon + d, lat - d], [lon + d, lat + d]]),
    way('north', [[lon + d, lat + d], [lon - d, lat + d]]),
    way('west', [[lon - d, lat + d], [lon - d, lat - d]]),
  ];
  const cross = [
    way('across', [[lon - d, lat], [lon + d, lat]]),
    way('along', [[lon, lat - d], [lon, lat + d]]),
  ];
  await page.route('**/blocks/roads**', async (route: Route) => {
    if (!['fetch', 'xhr'].includes(route.request().resourceType())) return route.fallback();
    requests.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ type: 'FeatureCollection', features: [...square, ...cross] }),
    });
  });
  return requests;
}

async function openLayerUrbanBlocks(page: Page): Promise<void> {
  const sheet = page.locator('#layers-sheet');
  if (!(await sheet.isVisible())) await page.locator('#layers-button').click();
  await expect(sheet).toBeVisible();
}

test('walking-time color and threshold controls recolor the block map and its legend', async ({ mockApi: page }) => {
  await openCity(page);
  await serveClosedBlocks(page);
  await openLayerUrbanBlocks(page);
  await page.locator('#showUrbanBlocks').check();
  await expect(page.locator('#urban-block-list button[data-block-id]')).toHaveCount(4);
  const colors = () => page.evaluate(() => Array.from((window as any).map.getPane('urbanBlocksPane').querySelectorAll('path'))
    .map((path: any) => path.getAttribute('fill')));
  const distinct = await colors();
  expect(new Set(distinct).size).toBeGreaterThan(1);
  await selectNativeOption(page.locator('#urban-blocks-color-by'), 'walk');
  await expect(page.locator('#urban-blocks-legend')).toContainText('10 min');
  await expect.poll(colors).not.toEqual(distinct);
  await selectNativeOption(page.locator('#urban-blocks-threshold'), '5');
  await expect(page.locator('#urban-blocks-legend')).toContainText('5 min');
  await expect(page.locator('#urban-block-list-status')).toContainText('above 5 min');
  await selectNativeOption(page.locator('#urban-blocks-color-by'), 'distinct');
  await expect(page.locator('#urban-blocks-legend')).toBeHidden();
  await expect.poll(colors).toEqual(distinct);
});

test('block-layout ranges, candidate visibility and alternative selection change the generated shared layout', async ({ mockApi: page, context }) => {
  test.setTimeout(90_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openCity(page);
  await serveClosedBlocks(page);
  await openLayerUrbanBlocks(page);
  await page.locator('#showUrbanBlocks').check();
  await expect(page.locator('#urban-block-list button[data-block-id]')).toHaveCount(4);
  await page.locator('#urban-block-list button[data-block-id]').first().click();
  const targetSummary = page.locator('.urban-block-target-summary strong');
  const originalTarget = await targetSummary.innerText();
  await selectNativeOption(page.locator('#urban-block-target-size'), '75');
  await expect(targetSummary).not.toHaveText(originalTarget);
  await page.locator('#urban-block-see-how').click();
  const dialog = page.locator('.urban-block-playground .on-map-editor__panel');
  await expect(dialog).toBeVisible();
  // Candidate points, pieces and new streets are drawn on the map; the panel holds the controls.
  const candidates = page.locator('path.urban-block-playground__candidate');
  await expect(candidates.first()).toBeVisible();
  // The block stays framed beside the playground panel: hiding the block panel must not re-fit it
  // without that panel's padding, under the playground.
  const outline = await page.locator('path.urban-block-playground__outline').boundingBox();
  const panelBox = await dialog.boundingBox();
  expect(outline!.x + outline!.width).toBeLessThanOrEqual(panelBox!.x);

  const settings = [
    { id: 'urban-block-playground-target-area', name: 'targetAreaM2', key: 'Home', value: 1000 },
    { id: 'urban-block-playground-max-side', name: 'maxSideM', key: 'ArrowLeft', value: 125 },
    { id: 'urban-block-playground-perimeter-step', name: 'perimeterStepM', key: 'Home', value: 50 },
  ];
  for (const setting of settings) {
    const slider = dialog.locator(`#${setting.id}`);
    await slider.focus();
    await slider.press(setting.key);
    await expect(slider).toHaveValue(String(setting.value));
    await expect.poll(async () => Number((await dialog.locator(`[data-output="${setting.name}"]`).innerText()).replace(/[^0-9]/g, ''))).toBe(setting.value);
  }
  for (const field of ['showTJunctions', 'showDeadEnds', 'showPerimeter']) {
    const toggle = dialog.locator(`[data-visibility="${field}"]`);
    await toggle.focus();
    await toggle.press('Space');
    await expect(toggle).not.toBeChecked();
  }
  await expect(candidates).toHaveCount(0);
  await expect(dialog.locator('[data-slot="candidate-info"]')).toBeHidden();
  for (const field of ['showTJunctions', 'showDeadEnds', 'showPerimeter']) {
    const toggle = dialog.locator(`[data-visibility="${field}"]`);
    await toggle.focus();
    await toggle.press('Space');
    await expect(toggle).toBeChecked();
  }
  await expect(candidates.first()).toBeVisible();
  await dialog.locator('[data-action="generate"]').click();
  const layouts = dialog.locator('#urban-block-playground-layout');
  await expect(layouts).toBeEnabled({ timeout: 60_000 });
  await expect.poll(() => dialog.locator('.urban-block-playground__piece-row').count()).toBeGreaterThan(1);
  // Share puts the layout link in the address bar (and the clipboard when permitted).
  await dialog.locator('[data-action="share"]').click();
  await expect(page).toHaveURL(/#splits=/);
  const firstLink = page.url();
  const first = await page.evaluate(url => (window as any).UrbanBlocksLinks.parse(url).subdivision, firstLink);
  expect(first.options).toMatchObject({ targetAreaM2: 1000, maxSideM: 125, perimeterStepM: 50 });
  await selectNativeOption(layouts, '1');
  await dialog.locator('[data-action="share"]').click();
  await expect.poll(() => page.url()).not.toBe(firstLink);
  const second = await page.evaluate(url => (window as any).UrbanBlocksLinks.parse(url).subdivision, page.url());
  expect(second.options).toEqual(first.options);
  expect(second.cuts).not.toEqual(first.cuts);
});

test('Propose turns the selected layout\'s new streets into applied road proposals', async ({ mockApi: page }) => {
  test.setTimeout(90_000);
  await openCity(page);
  await serveClosedBlocks(page);
  await openLayerUrbanBlocks(page);
  await page.locator('#showUrbanBlocks').check();
  const firstRow = page.locator('#urban-block-list button[data-block-id]').first();
  const original = await firstRow.getAttribute('data-block-id');
  const blockIds = () => page.evaluate(() => (window as any).UrbanBlocksView.snapshot().blocks?.features.map((block: any) => block.id) || []);
  const before = await blockIds();
  await firstRow.click();
  await page.locator('#urban-block-see-how').click();
  const dialog = page.locator('.urban-block-playground .on-map-editor__panel');
  const propose = dialog.locator('[data-action="propose"]');
  await expect(propose).toBeDisabled();
  for (const [id, key] of [['urban-block-playground-target-area', 'Home'], ['urban-block-playground-perimeter-step', 'Home']]) {
    await dialog.locator(`#${id}`).focus();
    await dialog.locator(`#${id}`).press(key);
  }
  await dialog.locator('[data-action="generate"]').click();
  await expect(propose).toBeEnabled({ timeout: 60_000 });
  const streets = () => page.evaluate(() => (window as any).proposalStorage.getAllProposals()
    .filter((proposal: any) => proposal.roadProposal?.definition?.metadata?.source === 'block-breakup').length);
  expect(await streets()).toBe(0);
  await propose.click();
  await expect(dialog).toBeHidden();
  await expect.poll(streets).toBeGreaterThan(0);
  const proposed = await page.evaluate(() => (window as any).proposalStorage.getAllProposals()
    .filter((proposal: any) => proposal.roadProposal?.definition?.metadata?.source === 'block-breakup')
    .map((proposal: any) => ({ goal: proposal.goal, title: proposal.title })));
  expect(proposed.every(proposal => proposal.goal === 'road-track')).toBe(true);
  await expectStatusLogged(page, `Proposed ${proposed.length} of`);
  // The applied streets split the block: it is gone, its pieces replace it, the rest keep their ids.
  await expect.poll(async () => (await blockIds()).includes(original)).toBe(false);
  const after = await blockIds();
  expect(after.length).toBeGreaterThan(before.length);
  expect(before.filter(id => id !== original).every(id => after.includes(id))).toBe(true);
  await expect(page.locator('#urban-block-panel-title')).toHaveText('Blocks in this area');
});

test('OSM block browse, details, fit, copy, collapse, refresh, back, and close buttons work', async ({ mockApi: page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openCity(page);
  const requests = await serveClosedBlocks(page);
  await openLayerUrbanBlocks(page);
  await page.locator('#showUrbanBlocks').check();
  await expect(page.locator('#urban-blocks-status')).toContainText('4 blocks', { timeout: 30_000 });
  await expect(page.locator('#urban-block-panel')).toBeVisible();
  await expect(page.locator('#layers-sheet')).toBeHidden();

  // Browse is a second entry to the same list from Layers after the toggle opened the panel.
  await openLayerUrbanBlocks(page);
  const browse = page.locator('#urban-blocks-browse');
  await expect(browse).toBeEnabled();
  await browse.click();
  const panel = page.locator('#urban-block-panel');
  const list = page.locator('#urban-block-list-view');
  await expect(panel).toBeVisible();
  await expect(list).toBeVisible();
  const rows = page.locator('#urban-block-list button[data-block-id]');
  await expect(rows).toHaveCount(4);

  // Closing the list reveals the floating open-map entry point; it reopens the same browser.
  await page.locator('#urban-block-close').click();
  await expect(panel).toBeHidden();
  const openMap = page.locator('#urban-blocks-open-map');
  await expect(openMap).toBeVisible();
  await openMap.click();
  await expect(panel).toBeVisible();
  await expect(list).toBeVisible();

  const selectedRow = rows.first();
  const blockId = await selectedRow.getAttribute('data-block-id');
  expect(blockId).toMatch(/^osm-block-/);
  await selectedRow.click();
  const details = page.locator('#urban-block-details-view');
  await expect(details).toBeVisible();
  await expect(list).toBeHidden();
  await expect(page.locator('#urban-block-copy')).toBeVisible();
  await expect(page.locator('#urban-block-fit')).toBeVisible();

  await page.locator('#urban-block-copy').click();
  const copiedLink = await page.evaluate(() => navigator.clipboard.readText());
  expect(new URL(copiedLink).searchParams.get('block')).toBe(blockId);

  // Drag the map away from the selected block, then confirm Fit restores its framing.
  const targetCenter = await page.evaluate(() => {
    const center = (window as any).map.getCenter();
    return { lat: center.lat, lng: center.lng };
  });
  const mapBox = await page.locator('#map').boundingBox();
  if (!mapBox) throw new Error('Map is not visible');
  const startX = mapBox.x + mapBox.width * 0.35;
  const startY = mapBox.y + mapBox.height * 0.55;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 180, startY + 90, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(target => {
    const center = (window as any).map.getCenter();
    return Math.abs(center.lat - target.lat) > 0.0001 || Math.abs(center.lng - target.lng) > 0.0001;
  }, targetCenter)).toBe(true);
  await page.locator('#urban-block-fit').click();
  await expect.poll(() => page.evaluate(target => {
    const center = (window as any).map.getCenter();
    return Math.abs(center.lat - target.lat) < 0.00002 && Math.abs(center.lng - target.lng) < 0.00002;
  }, targetCenter)).toBe(true);

  const collapse = page.locator('#urban-block-collapse');
  await collapse.click();
  await expect(collapse).toHaveAttribute('aria-expanded', 'false');
  await expect(panel).toHaveClass(/is-collapsed/);
  await collapse.click();
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  await expect(panel).not.toHaveClass(/is-collapsed/);

  await page.locator('#urban-block-see-how').click();
  const playground = page.locator('.urban-block-playground .on-map-editor__panel');
  await expect(playground).toBeVisible();
  const junction = page.locator('path.urban-block-playground__candidate.is-t').first();
  await expect(junction).toBeVisible();
  await junction.click();
  await expect(junction).toHaveClass(/is-inspected/);
  await expect(page.locator('path.urban-block-playground__trace-source')).toHaveCount(1);
  await expect(playground.locator('[data-slot="candidate-info"]')).not.toContainText('Hover or tap');
  await playground.locator('[data-action="generate"]').click();
  const pieces = playground.locator('.urban-block-playground__piece-row');
  await expect(pieces.first()).toBeVisible({ timeout: 30_000 });
  await pieces.first().click();
  await expect(pieces.first()).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('path.urban-block-playground__piece.is-highlighted')).toHaveCount(1);
  await playground.locator('[data-action="share"]').click();
  await expect(page).toHaveURL(/#splits=/);
  expect(new URL(page.url()).searchParams.get('block')).toBe(blockId);
  await playground.locator('.on-map-editor__header .close-circle-btn').click();
  await expect(playground).toBeHidden();

  await page.locator('#urban-block-back').click();
  await expect(details).toBeHidden();
  await expect(list).toBeVisible();
  const requestsBeforeRefresh = requests.length;
  await page.locator('#urban-block-list-refresh').click();
  await expect.poll(() => requests.length).toBeGreaterThan(requestsBeforeRefresh);
  await expect(page.locator('#urban-block-list-status')).toContainText(/Select a row|blocks/);
  // Fit has narrowed the viewport to the chosen block; refresh queries that new area.
  await expect(rows).toHaveCount(2);

  await page.locator('#urban-block-close').click();
  await expect(panel).toBeHidden();
  await expect(openMap).toBeVisible();
});

const PARCEL_IDS = [
  'HR-335754-1234', 'HR-335754-1235', 'HR-335754-1236', 'HR-335754-1237', 'HR-335754-1238',
];
const BLOCK_DATA = 'mapShell.reorg.blockData';

test('parcel block inspector tabs switch to their supported information and tools', async ({ mockApi: page }) => {
  await installLayerDatasets(page);
  await openCity(page);
  await page.evaluate(async ids => {
    await (window as any).CadastralParcelRepository.ensureIds(ids);
  }, PARCEL_IDS);
  await expect.poll(() => page.evaluate(ids => ids.filter((id: string) => !!(window as any).ParcelPresenter.getLayer(id)).length, PARCEL_IDS)).toBe(PARCEL_IDS.length);

  await openParcel(page);
  await page.locator('.multi-select-detect-btn').click();
  await expect.poll(() => page.evaluate(() => (window as any).multiParcelSelection.selectedParcels.size)).toBeGreaterThan(1);

  const sheet = page.locator('#layers-sheet');
  if (!(await sheet.isVisible())) await page.locator('#layers-button').click();
  const blockTools = sheet.locator(`details.layer-actions:has(> summary[data-i18n-key="${BLOCK_DATA}"])`);
  if (!(await blockTools.evaluate((el: HTMLDetailsElement) => el.open))) await blockTools.locator('> summary').click();
  await blockTools.locator('button[onclick="countBlocks()"]').click();
  await expect.poll(() => page.evaluate(() => (window as any).statusLogEntries().some((entry: any) => entry.message.includes('Finished count.')))).toBe(true);
  await page.locator('#showBlockListButton').click();
  const blockItem = page.locator('#blocks-content .block-item').first();
  await expect(blockItem).toBeVisible();
  await blockItem.click();
  await page.locator('#layers-sheet [data-sheet-close]').click();
  await expect(sheet).toBeHidden();

  const panel = page.locator('#block-info-panel');
  await expect(panel).toBeVisible();
  const infoTab = page.locator('#block-info-tab-button');
  const proposalsTab = page.locator('#block-proposals-tab-button');
  const toolsTab = page.locator('#block-tools-tab-button');
  await expect(page.locator('#block-info-tab')).toBeVisible();

  await proposalsTab.click();
  await expect(proposalsTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#block-proposals-tab')).toBeVisible();
  await expect(page.locator('#block-proposals-content')).toContainText(/No proposals for this block yet/i);

  await toolsTab.click();
  await expect(toolsTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#block-tools-tab')).toBeVisible();
  await expect(page.locator('#block-tools-content')).toContainText('Zoom to block');
  await expect(page.locator('#block-tools-content')).toContainText('Show vertices');
  const vertices = page.locator('#block-vertices-button');
  const vertexMarkerPaths = page.locator('#map .leaflet-overlay-pane path.leaflet-interactive[stroke="#222"][stroke-width="1.5"][fill="white"][fill-opacity="1"]');
  const markerCountBefore = await vertexMarkerPaths.count();
  await vertices.click();
  await expect(vertices).toHaveText('Hide vertices');
  await expect.poll(() => vertexMarkerPaths.count()).toBeGreaterThan(markerCountBefore);
  await vertices.click();
  await expect(vertices).toHaveText('Show vertices');
  await expect.poll(() => vertexMarkerPaths.count()).toBe(markerCountBefore);
  const fittedZoom = await page.evaluate(() => (window as any).map.getZoom());
  await page.mouse.move(550, 450);
  await page.mouse.wheel(0, 150);
  await expect.poll(() => page.evaluate(() => (window as any).map.getZoom())).toBeLessThan(fittedZoom);
  const zoomedOut = await page.evaluate(() => (window as any).map.getZoom());
  await page.locator('#block-zoom-button').click();
  await expect.poll(() => page.evaluate(() => (window as any).map.getZoom())).toBeGreaterThan(zoomedOut);
  expect(await page.evaluate(() => {
    const w = window as any;
    const name = JSON.parse(document.querySelector('#block-info-title')!.getAttribute('data-i18n-params')!).name;
    const viewport = w.map.getBounds();
    return w.blockStorage.blocks.get(name).parcels.every((layer: any) => viewport.contains(layer.getBounds()));
  })).toBe(true);

  await infoTab.click();
  await expect(infoTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#block-info-tab')).toBeVisible();
  await expect(page.locator('#block-info-content')).toContainText('Block name:');
  await panel.locator('.close-button').click();
  await expect(panel).not.toHaveClass(/visible/);
  await page.locator('#layers-button').click();
  await expect(page.locator('#blocks-list-container')).toBeVisible();
  await page.locator('.blocks-list-close').click();
  await expect(page.locator('#blocks-list-container')).toBeHidden();
});
