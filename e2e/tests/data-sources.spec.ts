// Settings → Data sources: a person's own parcel and building sources, kept in this browser per city
// (frontend/js/parcel-source-settings.js). The building flow is driven end to end against a mocked
// discover endpoint: check, pick the height unit, use it (saved + reload), see it ride every
// /buildings/* request as `source`, then return to the city default.
import { test, expect } from '../helpers/fixtures';
import { openCity } from '../helpers/runtime';
import { waitForMapReady } from '../helpers/app';

const URL_IN = 'https://data.example/arcgis/rest/services/Buildings/FeatureServer/0';
const descriptor = (heightUnit: string) => ({
  adapter: 'arcgis', endpoint: URL_IN, cityIds: ['zagreb'], metricSrid: 32633, idField: 'OBJECTID', objectIdField: 'OBJECTID',
  idType: 'integer', outFields: ['OBJECTID', 'HEIGHT'], kind: 'building', heightField: 'HEIGHT', heightUnit,
  idPrefix: 'CUSTOM-B-0123456789abcdef0123-',
});
const sourceId = (heightUnit: string) => 'building.' + Buffer.from(JSON.stringify(descriptor(heightUnit))).toString('base64url');

test.describe('Data sources @features', () => {
  test('Settings shows parcel source information and both source dialogs; a building source is checked, used, sent and reset', async ({ mockApi: page }) => {
    const discoverBodies: any[] = [];
    await page.route('**/building-sources/discover', route => {
      const body = route.request().postDataJSON(); discoverBodies.push(body);
      const unit = body.heightUnit || 'm';
      return route.fulfill({ json: { source: { ...descriptor(unit), id: sourceId(unit), name: 'data.example (arcgis)' },
        attempts: [{ adapter: 'arcgis', status: 'verified' }], buildingCount: 4 } });
    });
    await openCity(page);
    await page.locator('#settings-button').click();

    // Where this city's parcels come from (catalog metadata, mocked by the fixture).
    await page.locator('#parcel-source-notice-button').click();
    const notice = page.getByRole('alertdialog');
    await expect(notice).toBeVisible();
    await notice.getByRole('button').last().click();
    await expect(notice).toHaveCount(0);

    // The source pickers sit beside their layers in the Layers sheet since fbe3758d.
    await page.locator('#layers-button').click();
    await expect(page.locator('#layers-sheet')).toBeVisible();
    await page.locator('#parcel-source-settings-button').click();
    const dialog = page.locator('#parcel-source-settings');
    await expect(dialog.getByRole('heading')).toHaveText('Choose a parcel source');
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);

    // Opening a dialog may fold the sheet away; reopen it as a person would.
    if (!(await page.locator('#building-source-settings-button').isVisible())) await page.locator('#layers-button').click();
    await page.locator('#building-source-settings-button').click();
    await expect(dialog.getByRole('heading')).toHaveText('Choose a building source');
    await dialog.locator('#parcel-source-url').fill(URL_IN);
    await dialog.getByRole('button', { name: 'Check URL' }).click();
    const result = dialog.locator('.parcel-source-settings__result');
    await expect(result).toContainText('4 buildings in the test area');
    await expect(result).toContainText('Heights from the field HEIGHT');
    await result.getByLabel('Height unit').selectOption('ft');
    await expect.poll(() => discoverBodies.length).toBe(2);
    expect(discoverBodies[1]).toMatchObject({ url: URL_IN, city: 'zagreb', heightUnit: 'ft' });
    await expect(result.getByLabel('Height unit')).toHaveValue('ft');

    const reloaded = page.waitForNavigation();
    await dialog.getByRole('button', { name: 'Use this source' }).click();
    await reloaded; await waitForMapReady(page);
    expect(new URL(page.url()).searchParams.get('buildingSource')).toBe(sourceId('ft'));
    expect(await page.evaluate(() => (window as any).CityConfigManager.getBuildingSourceId())).toBe(sourceId('ft'));
    expect(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('cb_building_source:') && key.endsWith(':zagreb')))).toBe(true);

    const footprints = page.waitForRequest(request => request.url().endsWith('/buildings/footprints') && request.method() === 'POST');
    await page.evaluate(() => (window as any).ensureBuildingFootprintsForBounds((window as any).map.getBounds()));
    expect((await footprints).postDataJSON()).toMatchObject({ city: 'zagreb', source: sourceId('ft') });

    await page.locator('#layers-button').click();
    await page.locator('#building-source-settings-button').click();
    await expect(dialog).toContainText('Current source: data.example (arcgis)');
    const backToDefault = page.waitForNavigation();
    await dialog.getByRole('button', { name: 'Use the city default' }).click();
    await backToDefault; await waitForMapReady(page);
    expect(new URL(page.url()).searchParams.has('buildingSource')).toBe(false);
    expect(await page.evaluate(() => (window as any).CityConfigManager.getBuildingSourceId())).toBeUndefined();
    expect(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('cb_building_source:') && key.endsWith(':zagreb')))).toBe(false);
  });

  test('A building load that fails says so with a retry and a source of your own, and panning waits like parcels do', async ({ mockApi: page }) => {
    let fail = true;
    let requests = 0;
    await page.route('**/buildings/osm?*', route => {
      requests += 1;
      return fail
        ? route.fulfill({ status: 503, headers: { 'Retry-After': '90' }, json: { error: 'OSM reference is rate-limited upstream.', retryAfter: 90 } })
        : route.fulfill({ json: { type: 'FeatureCollection', features: [], truncated: false, partial: false } });
    });
    await openCity(page);
    await page.evaluate(() => {
      const w = window as any;
      w.map.setView(w.map.getCenter(), 18, { animate: false });
      (document.getElementById('showBuildingsOsm') as HTMLInputElement).checked = true;
    });
    requests = 0;
    // A pan is a burst of moveends; the layer asks once, after the pause.
    await page.evaluate(() => { for (let i = 0; i < 5; i += 1) (window as any).map.panBy([40, 0], { animate: false }); });
    const banner = page.locator('#building-source-status');
    await expect(banner).toContainText('the OpenStreetMap server is busy');
    await expect(banner).toContainText('Try again in about 2 min, or plug in your own mirror or source.');
    expect(requests).toBe(1);

    await banner.getByRole('button', { name: 'Choose a building source' }).click();
    const dialog = page.locator('#parcel-source-settings');
    await expect(dialog.getByRole('heading')).toHaveText('Choose a building source');
    await expect(dialog).toContainText('OpenStreetMap mirror');
    await dialog.getByRole('button', { name: 'Close' }).click();

    fail = false;
    await banner.getByRole('button', { name: 'Retry buildings' }).click();
    await expect.poll(() => requests).toBe(2);
    await expect(banner).toHaveCount(0);
  });
});
