import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, PARCEL_ID } from '../helpers/runtime';
import { installLayerDatasets } from '../helpers/mocks/layer-datasets';

const PARCEL_IDS = ['HR-335754-1234', 'HR-335754-1235', 'HR-335754-1236', 'HR-335754-1237', 'HR-335754-1238'];

// The status bar shows only the latest line, and a background parcel load can replace a tool's
// result before the assertion reads it. The status log keeps every line, so assert against that.
async function expectStatusLogged(page: any, text: string) {
  await expect.poll(() => page.evaluate(t => (window as any).statusLogEntries().some((e: any) => e.message.includes(t)), text)).toBe(true);
}

async function openDatasetTools(page: any) {
  await installLayerDatasets(page);
  await openCity(page);
  await page.evaluate(async ids => {
    await (window as any).CadastralParcelRepository.ensureIds(ids);
  }, PARCEL_IDS);
  await expect.poll(() => page.evaluate(ids => ids.filter((id: string) => !!(window as any).ParcelPresenter.getLayer(id)).length, PARCEL_IDS)).toBe(PARCEL_IDS.length);
  await openLayerActions(page, ROAD_DATA);
}

// The Tools sheet is gone (fbe3758d): road and block tools sit in folded "… data and analysis"
// rows of the Layers sheet. Open the sheet (unless a tool left it open) and unfold the row.
const ROAD_DATA = 'mapShell.reorg.roadData';
const BLOCK_DATA = 'mapShell.reorg.blockData';
async function openLayerActions(page: any, summaryKey: string) {
  const sheet = page.locator('#layers-sheet');
  if (!(await sheet.isVisible())) await page.locator('#layers-button').click();
  await expect(sheet).toBeVisible();
  const fold = sheet.locator(`details.layer-actions:has(> summary[data-i18n-key="${summaryKey}"])`);
  if (!(await fold.evaluate((el: HTMLDetailsElement) => el.open))) await fold.locator('> summary').click();
  await expect(fold).toHaveAttribute('open', '');
}

test.describe('Dataset road tools @features', () => {
  test('OSM, GUP, and DGU road imports draw returned feature geometry', async ({ mockApi: page }) => {
    await openDatasetTools(page);
    await page.locator('button[onclick="drawOSMRoads()"]').click();
    await expect.poll(() => page.evaluate(() => (window as any).osmRoadGeoJSON?.features?.length || 0)).toBeGreaterThan(0);
    await openLayerActions(page, ROAD_DATA);
    const osmToggle = page.locator('#showOSMRoadLines');
    await expect(osmToggle).toBeChecked();
    // The dataset command loads the real features; the checkbox owns their map visibility.
    await osmToggle.uncheck();
    await expect.poll(() => page.evaluate(() => (window as any).map.hasLayer((window as any).osmRoadLayer))).toBe(false);
    await osmToggle.check();
    await expect.poll(() => page.evaluate(() => (window as any).map.hasLayer((window as any).osmRoadLayer))).toBe(true);

    await openLayerActions(page, ROAD_DATA);
    await page.locator('button[onclick="drawGUPRoads()"]').click();
    await expect.poll(() => page.evaluate(() => (window as any).gupRoadLayer?.getLayers?.().length || 0)).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => (window as any).map.hasLayer((window as any).gupRoadLayer))).toBe(true);

    await page.locator('button[onclick="drawWFSRoadParcels()"]').click();
    await expectStatusLogged(page, 'Drew 1 DGU road-usage polygons');
    const dguGeometryVisible = await page.evaluate(() => {
      const panes = Array.from(document.querySelectorAll('.leaflet-pane'));
      return panes.some(pane => pane.querySelectorAll('path').length > 0);
    });
    expect(dguGeometryVisible).toBe(true);
  });

  test('road detection and analysis update parcel ownership and show results', async ({ mockApi: page }) => {
    await openDatasetTools(page);
    await page.locator('button[onclick="detectRoadsFromOSM()"]').click();
    // road detection loads on first use (optional-tools-loader.js): isRoadParcel exists once it has
    await expect.poll(() => page.evaluate(ids => typeof (window as any).isRoadParcel === 'function'
      && ids.some((id: string) => (window as any).isRoadParcel(id)), PARCEL_IDS)).toBe(true);
    const detectedId = await page.evaluate(ids => ids.find((id: string) => (window as any).isRoadParcel(id)), PARCEL_IDS);
    const roadStyle = await page.evaluate(id => (window as any).ParcelPresenter.getLayer(id).options.fillColor, detectedId);
    expect(roadStyle).toBeTruthy();

    await page.locator('button[onclick="drawGUPRoads()"]').click();
    await expect.poll(() => page.evaluate(() => (window as any).gupRoadGeoJSON?.features?.length || 0)).toBeGreaterThan(0);
    await page.locator('button[onclick="detectRoadsFromGUP()"]').click();
    await expectStatusLogged(page, 'GUP detection complete');
    await page.locator('button[onclick="detectRoadsFromWFS()"]').click();
    await expectStatusLogged(page, 'DGU detection complete');

    await page.locator('#analyzeAllRoadsButton').click();
    await expect(page.locator('#osm-road-segment-list-popup')).toBeVisible();
    await page.locator('#osm-road-segment-list-popup .close-button').click();
    // Analysis opens its own segment sheet over the map. Back in the Layers sheet's road row, the
    // visibility control for the analysis result appears once the result exists.
    await openLayerActions(page, ROAD_DATA);
    await expect(page.locator('#road-analysis-toggle')).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).osmRoadAnalysisLayer?.getLayers?.().length || 0)).toBeGreaterThan(0);
    await page.locator('#toggleRoadAnalysisResults').uncheck();
    await expect.poll(() => page.evaluate(() => (window as any).map.hasLayer((window as any).osmRoadAnalysisLayer))).toBe(false);
    await page.locator('#toggleRoadAnalysisResults').check();
    await expect.poll(() => page.evaluate(() => (window as any).map.hasLayer((window as any).osmRoadAnalysisLayer))).toBe(true);

    await openLayerActions(page, ROAD_DATA);
    await page.locator('#detectExistingRoadsButton').click();
    await expectStatusLogged(page, 'Existing roads loaded');
    await expect.poll(() => page.evaluate(id => (window as any).isRoadParcel(id), PARCEL_ID)).toBe(true);
  });

  test('reform, list, and detect block operate on the loaded live parcel fabric', async ({ mockApi: page }) => {
    await installLayerDatasets(page);
    await openCity(page);
    await page.evaluate(async ids => { await (window as any).CadastralParcelRepository.ensureIds(ids); }, PARCEL_IDS);
    await expect.poll(() => page.evaluate(ids => ids.filter((id: string) => !!(window as any).ParcelPresenter.getLayer(id)).length, PARCEL_IDS)).toBe(PARCEL_IDS.length);
    await openParcel(page);
    await page.locator('.multi-select-detect-btn').click();
    await expect.poll(() => page.evaluate(() => {
      return (window as any).multiParcelSelection.selectedParcels.has('HR-335754-1234')
        && (window as any).multiParcelSelection.selectedParcels.size > 1;
    })).toBe(true);

    await openLayerActions(page, BLOCK_DATA);
    await page.locator('button[onclick="countBlocks()"]').click();
    await expectStatusLogged(page, 'Finished count.');
    const blocks = page.locator('#blocks-content .block-item');
    await page.locator('#showBlockListButton').click();
    await expect(blocks.first()).toBeVisible();
    await blocks.first().click();
    await expect(page.locator('#block-info-panel')).toBeVisible();
    const selectedBlock = await page.evaluate(() => (window as any).selectedBlockName);
    expect(selectedBlock).toBeTruthy();
    expect(await page.evaluate(name => (window as any).blockStorage.blocks.has(name), selectedBlock)).toBe(true);

    const layersSheet = page.locator('#layers-sheet');
    if (!(await layersSheet.isVisible())) await page.locator('#layers-button').click();
    await expect(layersSheet).toBeVisible();
    const blockPaths = () => page.evaluate(() => document.querySelectorAll('#map .leaflet-overlay-pane path').length);
    const pathsBeforeHide = await blockPaths();
    await page.locator('#parcelBlocksCheckbox').uncheck();
    await expect.poll(blockPaths).toBeLessThan(pathsBeforeHide);
    await page.locator('#parcelBlocksCheckbox').check();
    await expect.poll(blockPaths).toBeGreaterThan(0);
    await expect(page.locator('.block-name-label').first()).toBeVisible();
    await page.locator('#showBlockNames').uncheck();
    await expect(page.locator('.block-name-label')).toHaveCount(0);
    await page.locator('#showBlockNames').check();
    await expect(page.locator('.block-name-label').first()).toBeVisible();

  });
});
