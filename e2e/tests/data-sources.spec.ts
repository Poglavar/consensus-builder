import { openLayerSection } from '../helpers/layers';
import { selectNativeOption } from '../helpers/controls';
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

    // The parcel source notice lives in the expanded Information section.
    const info = page.locator('#settings-sheet details.accordion-section[data-section="info"]');
    if (!(await info.evaluate((details: HTMLDetailsElement) => details.open))) await info.locator(':scope > summary').click();
    await expect(info).toHaveAttribute('open', '');
    // Where this city's parcels come from (catalog metadata, mocked by the fixture).
    await page.locator('#parcel-source-notice-button').click();
    const notice = page.getByRole('alertdialog');
    await expect(notice).toBeVisible();
    await notice.getByRole('button').last().click();
    await expect(notice).toHaveCount(0);

    // The source pickers sit beside their layers in the Layers sheet since fbe3758d.
    await page.locator('#layers-button').click();
    await expect(page.locator('#layers-sheet')).toBeVisible();
    await openLayerSection(page, 'parcels');
    await page.locator('#parcel-source-settings-button').click();
    const dialog = page.locator('#parcel-source-settings');
    await expect(dialog.getByRole('heading')).toHaveText('Choose a parcel source');
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);

    // Opening a dialog may fold the sheet away; reopen it as a person would.
    await openLayerSection(page, 'buildings');
    await page.locator('#building-source-settings-button').click();
    await expect(dialog.getByRole('heading')).toHaveText('Choose a building source');
    await dialog.locator('#parcel-source-url').fill(URL_IN);
    await dialog.getByRole('button', { name: 'Check URL' }).click();
    const result = dialog.locator('.parcel-source-settings__result');
    await expect(result).toContainText('4 buildings in the test area');
    await expect(result).toContainText('Heights from the field HEIGHT');
    await selectNativeOption(result.getByLabel('Height unit'), 'ft');
    await expect.poll(() => discoverBodies.length).toBe(2);
    expect(discoverBodies[1]).toMatchObject({ url: URL_IN, city: 'zagreb', heightUnit: 'ft' });
    await expect(result.getByLabel('Height unit')).toHaveValue('ft');

    // Keep the page navigation separate from the first provider fetch on the selected source.
    const reloaded = page.waitForNavigation();
    await dialog.getByRole('button', { name: 'Use this source' }).click();
    await reloaded; await waitForMapReady(page);
    expect(new URL(page.url()).searchParams.get('buildingSource')).toBe(sourceId('ft'));
    expect(await page.evaluate(() => (window as any).CityConfigManager.getBuildingSourceId())).toBe(sourceId('ft'));
    expect(await page.evaluate(() => {
      const w = window as any;
      return w.BrowserWorkspace.storage.getItem(w.ParcelSourceSettings.storageKey('zagreb', w, 'building'));
    })).toBe(sourceId('ft'));

    // Building footprints are fetched only when their layer is enabled. Trigger the first request
    // after the source-switch reload so it proves that the selected source is sent.
    await openLayerSection(page, 'buildings');
    const footprints = page.waitForRequest(request => request.url().endsWith('/buildings/footprints') && request.method() === 'POST');
    await page.locator('#showBuildings').check();
    const footprintsBody = (await footprints).postDataJSON();
    expect(footprintsBody).toMatchObject({ source: sourceId('ft') });
    expect(footprintsBody.city).toBeUndefined();

    await openLayerSection(page, 'buildings');
    await page.locator('#building-source-settings-button').click();
    await expect(dialog).toContainText('Current source: data.example (arcgis)');
    const backToDefault = page.waitForNavigation();
    await dialog.getByRole('button', { name: 'Use the city default' }).click();
    await backToDefault; await waitForMapReady(page);
    expect(new URL(page.url()).searchParams.has('buildingSource')).toBe(false);
    expect(await page.evaluate(() => (window as any).CityConfigManager.getBuildingSourceId())).toBe('gdi-3d');
    expect(await page.evaluate(() => {
      const w = window as any;
      return w.BrowserWorkspace.storage.getItem(w.ParcelSourceSettings.storageKey('zagreb', w, 'building'));
    })).toBeNull();
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
    await expect(banner).toContainText('Our server could not complete the building-data request (HTTP 503).');
    await expect(banner).toContainText('Try again in about 2 min, or plug in your own mirror or source.');
    expect(requests).toBe(1);

    await banner.getByRole('button', { name: 'Choose a building source' }).click();
    const dialog = page.locator('#parcel-source-settings');
    await expect(dialog.getByRole('heading')).toHaveText('Choose a building source');
    await expect(dialog).toContainText('OpenStreetMap mirror');
    await dialog.getByRole('button', { name: 'Close' }).click();

    // A successful building retry must not dismiss a still-failing parcel source.
    await page.evaluate(() => (window as any).ParcelSourceSettings.reportFailure(window, 'Parcel source is still unavailable.', 'parcel'));
    fail = false;
    await banner.getByRole('button', { name: 'Retry buildings' }).click();
    await expect.poll(() => requests).toBe(2);
    await expect(banner).toHaveCount(0);
    await expect(page.locator('#parcel-source-status')).toContainText('Parcel source is still unavailable.');
  });

  test('source warnings identify each layer and clear independently', async ({ mockApi: page }) => {
    await openCity(page);
    await page.evaluate(() => {
      const settings = (window as any).ParcelSourceSettings;
      for (const kind of ['parcel', 'building', 'imagery']) settings.clearFailure(window, kind);
      settings.reportFailure(window, 'Fixture parcel warning.', 'parcel');
      settings.reportFailure(window, 'Fixture building warning.', 'building');
      settings.reportFailure(window, 'Fixture imagery warning.', 'imagery');
    });

    const parcel = page.locator('#parcel-source-status');
    const building = page.locator('#building-source-status');
    const imagery = page.locator('#imagery-source-status');
    await expect(parcel.locator('h3')).toHaveText('Parcels unavailable');
    await expect(building.locator('h3')).toHaveText('Buildings unavailable');
    await expect(imagery.locator('h3')).toHaveText('Imagery unavailable');
    await expect(parcel.locator('i[aria-hidden="true"]')).toHaveClass(/fa-draw-polygon/);
    await expect(building.locator('i[aria-hidden="true"]')).toHaveClass(/fa-building/);
    await expect(imagery.locator('i[aria-hidden="true"]')).toHaveClass(/fa-satellite/);

    await page.evaluate(() => (window as any).ParcelSourceSettings.clearFailure(window, 'building'));
    await expect(building).toHaveCount(0);
    await expect(parcel).toContainText('Fixture parcel warning.');
    await expect(imagery).toContainText('Fixture imagery warning.');
    await page.evaluate(() => (window as any).ParcelSourceSettings.clearFailure(window, 'parcel'));
    await expect(parcel).toHaveCount(0);
    await expect(imagery).toBeVisible();
    await imagery.getByRole('button', { name: 'Dismiss source warning', exact: true }).click();
    await expect(imagery).toHaveCount(0);
  });
});
