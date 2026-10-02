import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';

const detail = (id: number, name: string, cityId = 'zagreb') => ({
  monitor: { id, name, cityId, parcelIds: [], createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z' },
  parcels: [], summary: { total: 0, governmentOwned: 0, remaining: 0 },
});

async function drawPolygonOnMap(page: import('@playwright/test').Page) {
  await page.locator('#tools-button').click();
  const draw = page.locator('#areaMonitorDrawButton');
  await draw.click();
  await page.locator('#tools-button').click();
  const map = page.locator('.leaflet-container').first();
  const box = await map.boundingBox();
  if (!box) throw new Error('Leaflet map has no visible bounds');
  const first = { x: box.x + box.width * 0.42, y: box.y + box.height * 0.43 };
  const points = [first, { x: first.x + 70, y: first.y + 4 }, { x: first.x + 42, y: first.y + 62 }];
  for (const point of points) await page.mouse.click(point.x, point.y);
  await page.mouse.click(first.x + 2, first.y + 2);
  await expect(page.locator('#area-monitor-creation-panel')).toBeVisible();
}

async function installCreateApi(page: import('@playwright/test').Page, failOnce = false) {
  const requests: any[] = [];
  await page.route('**/area-monitors**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.resourceType() !== 'fetch' && req.resourceType() !== 'xhr') return route.continue();
    if (req.method() === 'POST' && url.pathname.endsWith('/area-monitors')) {
      requests.push(req.postDataJSON());
      if (failOnce && requests.length === 1) {
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary save failure' }) });
      }
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 41, name: requests[requests.length - 1].name, cityId: 'zagreb', parcelIds: [] }) });
    }
    if (req.method() === 'GET' && url.pathname.endsWith('/area-monitors/41')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(detail(41, requests.length ? requests[requests.length - 1].name : 'Created monitor')) });
    }
    if (req.method() === 'GET' && url.pathname.endsWith('/area-monitors/41/overlay')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ type: 'FeatureCollection', features: [] }) });
    }
    return route.continue();
  });
  return requests;
}

test.describe('Area monitor authoring @features', () => {
  test('draws a polygon, validates the name, retries a failed POST, and routes to the created monitor', async ({ mockApi: page }) => {
    const requests = await installCreateApi(page, true);
    await page.goto('/?city=zg');
    await waitForMapReady(page);
    await drawPolygonOnMap(page);
    const name = page.locator('#am-name');
    await name.fill('ab');
    await page.locator('#am-create').click();
    await expect(page.locator('#am-error')).toContainText(/at least 3|min 3/i);
    expect(requests).toHaveLength(0);

    await name.fill('Riverside plan');
    await page.locator('#am-create').click();
    await expect(page.locator('#am-error')).toContainText('Temporary save failure');
    await expect(page.locator('#am-create')).toBeEnabled();
    await page.locator('#am-create').click();
    await expect(page).toHaveURL(/\/monitors\/41$/);
    expect(await page.evaluate(() => (window as any).CityConfigManager.getCurrentCityId())).toBe('zagreb');
    await expect(page.locator('#area-monitor-detail-panel')).toContainText('Riverside plan');
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ name: 'Riverside plan', cityId: 'zagreb', polygon: { type: 'Polygon' }, parcelIds: [] });
    expect(requests[0].polygon.coordinates[0]).toHaveLength(4);
  });

  test('draw cancellation drops the unfinished polygon and the unsupported upload stays disabled', async ({ mockApi: page }) => {
    await page.goto('/?city=zg');
    await waitForMapReady(page);
    await page.locator('#tools-button').click();
    const draw = page.locator('#areaMonitorDrawButton');
    await draw.click();
    await page.locator('#tools-button').click();
    const map = page.locator('.leaflet-container').first();
    const box = await map.boundingBox();
    if (!box) throw new Error('Leaflet map has no visible bounds');
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.keyboard.press('Escape');
    await expect(page.locator('#area-monitor-creation-panel')).toHaveCount(0);
    await page.locator('#tools-button').click();
    await expect(page.locator('#areaMonitorUploadButton')).toBeDisabled();
    // Plan painting becomes available only after the real road-plan layer has loaded.
    await expect(page.locator('#areaMonitorFromPlanButton')).toBeDisabled();
  });
});
