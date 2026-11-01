import { test, expect } from '../helpers/fixtures';
import { expectStatusLogged, openCity, openParcel, parcelTab } from '../helpers/runtime';
import { waitForMapReady } from '../helpers/app';
import { sampleParcels } from '../helpers/mocks/parcel-data';

test.describe('Parcel diagnostics @features', () => {
  test('road measurement renders calculated dimensions without changing the parcel', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'tools');
    const before = await page.evaluate(() => JSON.stringify((window as any).LiveParcelFabric.get((window as any).currentParcel.id)));
    // Road analysis loads on first use (51152a2e): nothing has measured before the button does.
    expect(await page.evaluate(() => typeof (window as any).calculateRoadMetrics)).toBe('undefined');
    await page.locator('#measureAsRoadButton').click();
    await expect(page.locator('#measureAsRoadButton')).toHaveText('Measurements added');
    const length = await page.evaluate(() => {
      const w = window as any;
      const metrics = w.calculateRoadMetrics(w.LiveParcelFabric.get(w.currentParcel.id).geometry.coordinates);
      // Lengths follow the UI language through one formatter (docs/design-language.md); English here.
      const metres = Number(metrics.length);
      return metres.toLocaleString('en-GB', { maximumFractionDigits: metres < 100 ? 1 : 0 });
    });
    await parcelTab(page, 'info-tab').click();
    await expect(page.locator('#roadMeasurements')).toBeVisible();
    await expect(page.locator('#roadMeasurements .metric-value').first()).toHaveText(new RegExp(`^${length.replace(/[.,]/g, '\\$&')}\\s?m$`)); // narrow no-break space before the unit
    await expect(page.locator('#roadMeasurements')).not.toContainText(/NaN|N\/A|undefined/);
    await expect(page.locator('#measureAsRoadButton')).toBeDisabled();
    expect(await page.evaluate(() => JSON.stringify((window as any).LiveParcelFabric.get((window as any).currentParcel.id)))).toBe(before);
  });

  test('Parcel Builder is in Tools, opens in Zagreb, and is unavailable in London', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'tools');
    const base = await page.evaluate(() => (window as any).CityConfigManager.getParcelBuilderConfig().url);
    await expect(page.locator('#propose-tab #parcelBuilderButton')).toHaveCount(0);
    await expect(page.locator('#tools-tab #parcelBuilderButton')).toBeEnabled();
    await page.context().route(`${base}**`, route => route.fulfill({ contentType: 'text/html', body: '<title>External tool fixture</title>' }));
    const opened = page.context().waitForEvent('page');
    await page.locator('#parcelBuilderButton').focus();
    await page.locator('#parcelBuilderButton').press('Enter');
    const child = await opened;
    await child.waitForURL(url => url.href.startsWith(base));
    expect(new URL(child.url()).searchParams.get('parcel_identifier')).toBe('1234-335754');
    await child.close();

    await page.goto('/?city=london&at=51.5098,-0.1263,18&reduceMotion=1', { waitUntil: 'domcontentloaded' });
    await waitForMapReady(page);
    const londonButton = page.locator('#tools-tab #parcelBuilderButton');
    await expect(londonButton).toBeDisabled();
    await expect(londonButton).toHaveAttribute('title', 'Not available in this city');
    await expect(page.locator('#propose-tab #parcelBuilderButton')).toHaveCount(0);
    const gated = await page.evaluate(() => {
      const w = window as any;
      let opens = 0, status = '';
      w.open = () => { opens += 1; };
      w.updateStatus = (message: string) => { status = message; };
      const result = w.ParcelsUIClaim.openParcelBuilder();
      return { opens, status, result };
    });
    expect(gated).toEqual({ opens: 0, status: 'Not available in this city', result: false });
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
    await expect(page.locator('#neighboursButton')).toHaveAttribute('aria-pressed', 'true');
    await expectStatusLogged(page, 'Highlighted 1 neighboring parcels');
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
    const originalZoom = await page.evaluate<number>('animationMap.getZoom()');
    const mainMapZoom = await page.evaluate(() => (window as any).map.getZoom());
    await modal.locator('.leaflet-control-zoom-out').click();
    await expect.poll(() => page.evaluate<number>('animationMap.getZoom()')).toBe(originalZoom - 1);
    await modal.locator('.leaflet-control-zoom-in').click();
    await expect.poll(() => page.evaluate<number>('animationMap.getZoom()')).toBe(originalZoom);
    expect(await page.evaluate(() => (window as any).map.getZoom())).toBe(mainMapZoom);
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
