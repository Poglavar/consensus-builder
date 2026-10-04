import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel } from '../helpers/runtime';
import { sampleParcels } from '../helpers/mocks/parcel-data';

test.describe('Parcel diagnostics @features', () => {
  test('road measurement renders calculated dimensions without changing the parcel', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'tools');
    const before = await page.evaluate(() => JSON.stringify((window as any).LiveParcelFabric.get((window as any).currentParcel.id)));
    const length = await page.evaluate(() => {
      const w = window as any;
      const metrics = w.calculateRoadMetrics(w.LiveParcelFabric.get(w.currentParcel.id).geometry.coordinates);
      // Lengths follow the UI language through one formatter (docs/design-language.md); English here.
      const metres = Number(metrics.length);
      return metres.toLocaleString('en-GB', { maximumFractionDigits: metres < 100 ? 1 : 0 });
    });
    await page.locator('#measureAsRoadButton').click();
    await page.locator('.parcel-tab-btn').filter({ hasText: 'Info' }).click();
    await expect(page.locator('#roadMeasurements')).toBeVisible();
    await expect(page.locator('#roadMeasurements .metric-value').first()).toHaveText(new RegExp(`^${length.replace(/[.,]/g, '\\$&')}\\s?m$`)); // narrow no-break space before the unit
    await expect(page.locator('#roadMeasurements')).not.toContainText(/NaN|N\/A|undefined/);
    await expect(page.locator('#measureAsRoadButton')).toBeDisabled();
    expect(await page.evaluate(() => JSON.stringify((window as any).LiveParcelFabric.get((window as any).currentParcel.id)))).toBe(before);
  });

  test('Parcel Builder opens the configured external tool with the selected cadastral identifier', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'tools');
    const base = await page.evaluate(() => (window as any).CityConfigManager.getParcelBuilderConfig().url);
    await page.context().route(`${base}**`, route => route.fulfill({ contentType: 'text/html', body: '<title>External tool fixture</title>' }));
    const opened = page.context().waitForEvent('page');
    await page.locator('#parcelBuilderButton').click();
    const child = await opened;
    await child.waitForURL(url => url.href.startsWith(base));
    expect(new URL(child.url()).searchParams.get('parcel_identifier')).toBe('1234-335754');
    await child.close();
  });
  test('neighbor highlighting and vertex markers follow actual adjacent cadastral geometry', async ({ mockApi: page }) => {
    const adjacent = JSON.parse(JSON.stringify(sampleParcels));
    for (const coordinate of adjacent.features[1].geometry.coordinates[0]) {
      if (coordinate[0] === 15.9826) coordinate[0] = 15.9825;
    }
    await page.route('**/parcels**', route => {
      if (!['fetch', 'xhr'].includes(route.request().resourceType())) return route.continue();
      return route.fulfill({ json: adjacent });
    });
    await openCity(page);
    await openParcel(page, 'tools');
    await page.locator('#neighboursButton').click();
    await expect(page.locator('#neighboursButton')).toHaveClass(/active/);
    await expect(page.locator('#floating-status-text')).toContainText('Highlighted 1 neighboring parcels');
    const highlights = () => page.evaluate(() => {
      let count = 0;
      (window as any).map.eachLayer((layer: any) => { if (layer.feature?.properties?.parcelId === 'HR-335754-1235' && layer.options?.weight === 3) count++; });
      return count;
    });
    await expect.poll(highlights).toBe(1);
    await page.locator('#neighboursButton').click();
    await expect.poll(highlights).toBe(0);
    await page.locator('#verticesButton').click();
    await expect.poll(() => page.evaluate(() => (window as any).verticesLayer.getLayers().length)).toBe(5);
    await page.locator('#verticesButton').click();
    await expect.poll(() => page.evaluate(() => (window as any).verticesLayer.getLayers().length)).toBe(0);
  });

  test('centerline visualization steps forward/backward, plays and closes its own map', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'tools');
    await page.locator('#visualizeButton').click();
    const modal = page.locator('#animation-modal');
    await expect(modal).toBeVisible();
    await expect(modal.locator('#animation-map')).toHaveClass(/leaflet-container/);
    const initial = await modal.locator('#animation-step').innerText();
    await modal.locator('#btn-next').click();
    await expect(modal.locator('#animation-step')).not.toHaveText(initial);
    await modal.locator('#btn-prev').click();
    await expect(modal.locator('#animation-step')).toHaveText(initial);
    await modal.locator('#btn-play').click();
    await expect(modal.locator('#btn-play')).toHaveText('Pause');
    await expect(modal.locator('#animation-step')).not.toHaveText(initial);
    await modal.locator('#animation-close').click();
    await expect(modal).toBeHidden();
    await expect(page.locator('#parcel-info-panel')).toBeVisible();
  });
});
