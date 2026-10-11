// Urban blocks · OSM (Layers sheet): the toggle loads OSM roads for the view, detects the blocks
// they enclose in the worker and draws them; "Refresh this area" loads the roads again. The road
// source is a protocol fixture: a crossed square around the view's centre encloses four blocks, a
// plain square one.
import { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { openCity } from '../helpers/runtime';
import { selectors } from '../helpers/selectors';

type Ring = 'crossed' | 'square';

// Roads of a square 0.002° across centred on the map, optionally crossed through the middle.
async function serveRoads(page: Page, shapes: Ring[]): Promise<string[]> {
  const requests: string[] = [];
  const [lat, lon] = await page.evaluate(() => {
    const center = (window as any).map.getCenter();
    return [center.lat, center.lng];
  });
  const d = 0.001;
  const way = (id: string, coordinates: number[][]) => ({ type: 'Feature', id, properties: { highway: 'residential', name: `Street ${id}` }, geometry: { type: 'LineString', coordinates } });
  const square = [
    way('south', [[lon - d, lat - d], [lon + d, lat - d]]), way('east', [[lon + d, lat - d], [lon + d, lat + d]]),
    way('north', [[lon + d, lat + d], [lon - d, lat + d]]), way('west', [[lon - d, lat + d], [lon - d, lat - d]]),
  ];
  const cross = [way('across', [[lon - d, lat], [lon + d, lat]]), way('along', [[lon, lat - d], [lon, lat + d]])];
  await page.route('**/blocks/roads**', async (route: Route) => {
    const request = route.request();
    if (request.resourceType() !== 'fetch' && request.resourceType() !== 'xhr') return route.fallback();
    requests.push(request.url());
    const shape = shapes[Math.min(requests.length, shapes.length) - 1];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ type: 'FeatureCollection', features: shape === 'crossed' ? [...square, ...cross] : square }),
    });
  });
  return requests;
}

const drawnBlocks = (page: Page) => page.evaluate(() => {
  const pane = (window as any).map.getPane('urbanBlocksPane');
  return pane ? pane.querySelectorAll('path').length : 0;
});

test.describe('Urban blocks @features', () => {
  test('the Layers toggle detects and draws the blocks the OSM roads enclose, Refresh reloads them, and off removes them', async ({ mockApi: page }) => {
    await openCity(page);
    const requests = await serveRoads(page, ['crossed', 'square']);

    await page.locator(selectors.layersButton).click();
    const sheet = page.locator(selectors.layersSheet);
    await expect(sheet).toBeVisible();
    const toggle = sheet.locator('#showUrbanBlocks');
    const status = sheet.locator('#urban-blocks-status');
    const refresh = sheet.locator('#urban-blocks-refresh');
    await expect(refresh).toBeDisabled();

    await toggle.check();
    await expect(status).toContainText('4 blocks', { timeout: 30_000 });
    expect(requests).toHaveLength(1);
    // the request covers the view (plus a margin), as west,south,east,north
    const bbox = new URL(requests[0]).searchParams.get('bbox')!.split(',').map(Number);
    const view = await page.evaluate(() => (window as any).map.getBounds().toBBoxString().split(',').map(Number));
    expect(bbox[0]).toBeLessThan(view[0]);
    expect(bbox[1]).toBeLessThan(view[1]);
    expect(bbox[2]).toBeGreaterThan(view[2]);
    expect(bbox[3]).toBeGreaterThan(view[3]);
    await expect.poll(() => drawnBlocks(page)).toBe(4);
    await expect(page.locator('#urban-block-list button[data-block-id]')).toHaveCount(4);
    // the blocks list replaces the sheet; Refresh lives in the Layers sheet, so open it again
    await expect(page.locator('#urban-block-panel')).toBeVisible();
    await expect(sheet).toBeHidden();
    await page.locator(selectors.layersButton).click();
    await expect(sheet).toBeVisible();

    await expect(refresh).toBeEnabled();
    await refresh.click();
    await expect(status).toContainText('1 blocks', { timeout: 30_000 });
    expect(requests).toHaveLength(2);
    await expect.poll(() => drawnBlocks(page)).toBe(1);
    await expect(page.locator('#urban-block-list button[data-block-id]')).toHaveCount(1);

    await page.locator(selectors.layersButton).click();
    await expect(sheet).toBeVisible();
    await toggle.uncheck();
    await expect.poll(() => drawnBlocks(page)).toBe(0);
    await expect(refresh).toBeDisabled();
    expect(requests).toHaveLength(2);
  });
});
