import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { selectors } from '../helpers/selectors';
const descriptor = (adapter = 'xyz') => {
  const value = { kind: 'imagery', adapter, cityIds: ['new_york'], name: 'Test orthophoto',
    endpoint: adapter === 'xyz' ? 'https://public.example/{z}/{x}/{y}.png' : 'https://public.example/wms',
    idPrefix: 'CUSTOM-I-1234567890abcdef1234-',
    ...(adapter === 'wms' ? { layers: ['ortho'], version: '1.3.0', crs: 'CRS:84', format: 'image/png' } : {}) };
  return { ...value, id: 'imagery.' + Buffer.from(JSON.stringify(value)).toString('base64url') };
};
async function openChooser(page: import('@playwright/test').Page) {
  await page.locator(selectors.layersButton).click();
  await page.locator('#imagery-source-settings-button').click();
  return page.locator('#parcel-source-settings');
}
test.describe('Imagery area sources', () => {
  test('verifies XYZ, persists through reload and resets to the standard map', async ({ mockApi: page }) => {
    const source = descriptor();
    await page.route('**/imagery-sources/discover', route => route.fulfill({ json: { source, attempts: [] } }));
    await page.route('**/imagery-sources/*/tiles/**', route => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAABmJLR0QA/wD/AP+gvaeTAAAAFElEQVQImWNkYGD4z8DAwMDEAAUADigBA7Y4ytMAAAAASUVORK5CYII=', 'base64') }));
    await page.goto('/?city=new_york&lang=en', { waitUntil: 'domcontentloaded' }); await waitForMapReady(page);
    const dialog = await openChooser(page);
    await dialog.locator('#parcel-source-url').fill(source.endpoint);
    await dialog.getByRole('button', { name: 'Check URL', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('Image verified');
    await dialog.getByRole('button', { name: 'Use this source', exact: true }).click();
    await page.waitForURL(/imagerySource=/); await waitForMapReady(page);
    await expect.poll(() => page.evaluate(() => (window as any).BasemapManager.getCurrentBasemapKey())).toBe('imagery');
    await expect.poll(() => page.locator('.leaflet-tile-pane img[src*="imagery-sources"]').count()).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLImageElement>('.leaflet-tile-pane img')].filter(i => i.complete && i.naturalWidth > 0).length)).toBeGreaterThan(0);
    await expect(page.locator('.map-credits-control')).toContainText('Test orthophoto');
    await page.evaluate(() => { (window as any).baseTileLayer.fire('tileerror', { tile: document.querySelector('.leaflet-tile-pane img') }); });
    await expect(page.locator('#imagery-source-status')).toBeVisible();
    await page.getByRole('button', { name: 'Retry imagery', exact: true }).click();
    await expect(page.locator('#imagery-source-status')).toHaveCount(0);
    await page.reload({ waitUntil: 'domcontentloaded' }); await waitForMapReady(page);
    expect(await page.evaluate(() => (window as any).BasemapManager.getCurrentBasemapKey())).toBe('imagery');
    await page.locator(selectors.layersButton).click();
    await page.locator('#tile-source-select').selectOption('openstreetmap');
    expect(await page.evaluate(() => (window as any).BasemapManager.getCurrentBasemapKey())).toBe('openstreetmap');
    expect(page.url()).not.toContain('imagerySource=');
    await page.reload({ waitUntil: 'domcontentloaded' }); await waitForMapReady(page);
    expect(await page.evaluate(() => (window as any).BasemapManager.getCurrentBasemapKey())).toBe('openstreetmap');
  });
  test('asks for a WMS layer and invalidates verification after editing URL', async ({ mockApi: page }) => {
    const requests: any[] = [];
    await page.route('**/imagery-sources/discover', async route => {
      const body = route.request().postDataJSON(); requests.push(body);
      await route.fulfill({ json: body.layers ? { source: descriptor('wms'), attempts: [] }
        : { selectionRequired: true, layers: [{ name: 'ortho', title: 'Orthophoto' }, { name: 'older', title: 'Older' }], attempts: [] } });
    });
    await page.goto('/?city=new_york&lang=en', { waitUntil: 'domcontentloaded' }); await waitForMapReady(page);
    const dialog = await openChooser(page);
    await dialog.locator('#parcel-source-url').fill('https://public.example/wms');
    await dialog.getByRole('button', { name: 'Check URL', exact: true }).click();
    await expect(dialog.getByRole('combobox', { name: 'WMS layer' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Use this source', exact: true })).toBeHidden();
    await dialog.getByRole('button', { name: 'Check URL', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('Image verified');
    expect(requests[1].layers).toEqual(['ortho']);
    await dialog.locator('#parcel-source-url').fill('https://different.example/wms');
    await expect(dialog.getByRole('button', { name: 'Use this source', exact: true })).toBeHidden();
  });
  test('a failed image check keeps use disabled', async ({ mockApi: page }) => {
    await page.route('**/imagery-sources/discover', route => route.fulfill({ status: 422, json: { code: 'imagery-not-image', error: 'Imagery provider did not return a PNG or JPEG map.' } }));
    await page.goto('/?city=new_york&lang=en', { waitUntil: 'domcontentloaded' }); await waitForMapReady(page);
    const dialog = await openChooser(page);
    await dialog.locator('#parcel-source-url').fill('https://public.example/wms');
    await dialog.getByRole('button', { name: 'Check URL', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('PNG or JPEG');
    await expect(dialog.getByRole('button', { name: 'Use this source', exact: true })).toBeHidden();
  });
});
