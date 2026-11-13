import { openLayerSection } from '../helpers/layers';
import { selectNativeOption } from '../helpers/controls';
// Settings → Data sources: a person's own parcel source and the city's building source list, kept in
// this browser per city (frontend/js/parcel-source-settings.js, frontend/js/source-list.js). The
// building list is edited in place: a source checked against a mocked discover endpoint is added
// first and in use, Outline and order are switched, and every change is saved at once with no reload.
import { test, expect } from '../helpers/fixtures';
import { openCity } from '../helpers/runtime';
import { waitForMapReady } from '../helpers/app';
import { createHash } from 'node:crypto';

const URL_IN = 'https://data.example/arcgis/rest/services/Buildings/FeatureServer/0';
const descriptor = (heightUnit: string) => ({
  adapter: 'arcgis', endpoint: URL_IN, cityIds: ['zagreb'], metricSrid: 32633, idField: 'OBJECTID', objectIdField: 'OBJECTID',
  idType: 'integer', outFields: ['OBJECTID', 'HEIGHT'], kind: 'building', heightField: 'HEIGHT', heightUnit,
  idPrefix: 'CUSTOM-B-0123456789abcdef0123-',
});
const sourceId = (heightUnit: string) => 'building.' + Buffer.from(JSON.stringify(descriptor(heightUnit))).toString('base64url');
const PARCEL_URL = 'https://data.example/arcgis/rest/services/Parcels/FeatureServer/0';
const parcelDescriptor = () => {
  const config = { adapter: 'arcgis', endpoint: new URL(PARCEL_URL).href, cityIds: ['zagreb'], metricSrid: 32633,
    idField: 'OBJECTID', objectIdField: 'OBJECTID', idType: 'integer', outFields: ['OBJECTID'] };
  const hash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 20);
  const value = { ...config, idPrefix: `CUSTOM-${hash}-` };
  return { ...value, id: `custom.${Buffer.from(JSON.stringify(value)).toString('base64url')}` };
};

// The person's stored building list for Zagreb, read from localStorage (a workspace may prefix the key).
const storedBuildingList = (page: import('@playwright/test').Page) => page.evaluate(() => {
  const key = Object.keys(localStorage).find(name => /(^|:)cb_building_sources:.*:zagreb$/.test(name));
  return key ? JSON.parse(localStorage.getItem(key) as string) : null;
});
// Counts the list's change events and marks this page, so a reload (a fresh window) shows.
const watchListChanges = (page: import('@playwright/test').Page) => page.evaluate(() => {
  const w = window as any;
  w.__sourceListChanges = 0;
  w.__samePage = true;
  w.addEventListener(w.SourceList.EVENT, () => { w.__sourceListChanges += 1; });
});
const listChanges = (page: import('@playwright/test').Page) => page.evaluate(() => ({
  samePage: (window as any).__samePage === true, changes: (window as any).__sourceListChanges,
}));

test.describe('Data sources @features', () => {
  test('a verified parcel source can be replaced with the city default', async ({ mockApi: page }) => {
    const source = parcelDescriptor();
    const features = Array.from({ length: 4 }, (_, index) => {
      // Keep these in the map's post-reload request area around Zagreb's default view.
      const west = 15.9780 + (index % 2) * 0.0013, south = 45.7995 + Math.floor(index / 2) * 0.0009;
      const east = west + 0.0002, north = south + 0.0002;
      return { type: 'Feature', id: index + 1, properties: { OBJECTID: index + 1 },
        geometry: { type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] } };
    });
    await page.route(/\/parcel-sources\/discover\?/, route => route.fulfill({ json: {
      source, attempts: [{ adapter: 'arcgis', status: 'verified' }], parcelCount: 4
    } }));
    await page.route('https://data.example/**', route => {
      const requestUrl = new URL(route.request().url());
      const params = new URLSearchParams(route.request().postData() || requestUrl.search);
      const json = params.get('returnCountOnly') === 'true' ? { count: features.length }
        : params.get('returnIdsOnly') === 'true' ? { objectIdFieldName: 'OBJECTID', objectIds: features.map(feature => feature.properties.OBJECTID) }
        : { type: 'FeatureCollection', features };
      return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, json });
    });
    await openCity(page);
    const defaults = await page.evaluate(() => {
      const w = window as any;
      return { key: w.ParcelSourceSettings.storageKey('zagreb', w, 'parcel'), id: w.CityConfigManager.getDataContext(null, 'zagreb').parcelSourceId };
    });
    await page.locator('#layers-button').click();
    await openLayerSection(page, 'parcels');
    await page.locator('#parcel-source-settings-button').click();
    let dialog = page.locator('#parcel-source-settings');
    await dialog.locator('#parcel-source-url').fill(PARCEL_URL);
    await dialog.getByRole('button', { name: 'Check URL', exact: true }).click();
    await expect(dialog.locator('.parcel-source-settings__result')).toContainText('4 parcels in the test area');
    await dialog.getByRole('button', { name: 'Use this source', exact: true }).click();
    await page.waitForURL(url => url.searchParams.get('parcelSource') === source.id);
    await waitForMapReady(page);
    expect(await page.evaluate(key => (window as any).BrowserWorkspace?.storage?.getItem(key) || localStorage.getItem(key), defaults.key)).toBe(source.id);
    expect(await page.evaluate(() => (window as any).CityConfigManager.getDataContext(null, 'zagreb').parcelSourceId)).toBe(source.id);
    await page.waitForFunction(id => (window as any).CadastralParcelRepository.list()
      .filter((feature: any) => feature.properties.sourceId === id).length === 4, source.id);
    const customParcels = await page.evaluate(id => (window as any).CadastralParcelRepository.list()
      .filter((feature: any) => feature.properties.sourceId === id).map((feature: any) => feature.properties), source.id);
    expect(customParcels.map((feature: any) => feature.sourceParcelId).sort()).toEqual(['1', '2', '3', '4']);
    expect(customParcels.every((feature: any) => feature.parcelId === source.idPrefix + feature.sourceParcelId
      && feature.id === feature.parcelId && feature.sourceId === source.id)).toBe(true);

    await page.locator('#layers-button').click();
    await openLayerSection(page, 'parcels');
    await page.locator('#parcel-source-settings-button').click();
    dialog = page.locator('#parcel-source-settings');
    await dialog.getByRole('button', { name: 'Use the city default', exact: true }).click();
    await page.waitForURL(url => !url.searchParams.has('parcelSource'));
    await waitForMapReady(page);
    expect(await page.evaluate(key => (window as any).BrowserWorkspace?.storage?.getItem(key) || localStorage.getItem(key), defaults.key)).toBeNull();
    expect(await page.evaluate(() => (window as any).CityConfigManager.getDataContext(null, 'zagreb').parcelSourceId)).toBe(defaults.id);
    expect(await page.evaluate(id => (window as any).CadastralParcelRepository.list()
      .filter((feature: any) => feature.properties.sourceId === id).length, source.id)).toBe(0);
  });

  test('Settings shows parcel source information and both source dialogs; a building source is checked and added to the list without a reload', async ({ mockApi: page }) => {
    const discoverBodies: any[] = [];
    await page.route(/\/building-sources\/discover\?/, route => {
      expect(route.request().method()).toBe('GET');
      const body = Object.fromEntries(new URL(route.request().url()).searchParams); discoverBodies.push(body);
      const unit = body.heightUnit || 'm';
      return route.fulfill({ json: { source: { ...descriptor(unit), id: sourceId(unit), name: 'data.example (arcgis)' },
        attempts: [{ adapter: 'arcgis', status: 'verified' }], buildingCount: 4 } });
    });
    await openCity(page);
    await page.locator('#settings-button').click();

    // Parcel source information is a direct Data & assumptions row.
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
    await watchListChanges(page);
    await openLayerSection(page, 'buildings');
    await page.locator('#building-source-settings-button').click();
    await expect(dialog.getByRole('heading')).toHaveText('Building sources');
    await dialog.getByText('Add a source').click();
    await dialog.locator('#parcel-source-url').fill(URL_IN);
    await dialog.getByRole('button', { name: 'Check URL' }).click();
    const result = dialog.locator('.parcel-source-settings__result');
    await expect(result).toContainText('4 buildings in the test area');
    await expect(result).toContainText('Heights from the field HEIGHT');
    await selectNativeOption(result.getByLabel('Height unit'), 'ft');
    await expect.poll(() => discoverBodies.length).toBe(2);
    expect(discoverBodies[1]).toMatchObject({ url: URL_IN, city: 'zagreb', heightUnit: 'ft' });
    await expect(result.getByLabel('Height unit')).toHaveValue('ft');

    // Added first and in use, saved at once, on the same page.
    await dialog.getByRole('button', { name: 'Add this source' }).click();
    await expect(result).toContainText('data.example (arcgis) is now first in the list, in use.');
    const rows = dialog.locator('.source-list-editor__row');
    await expect(rows).toHaveCount(4);
    await expect(rows.first()).toContainText('data.example (arcgis)');
    expect(await storedBuildingList(page)).toEqual([
      { id: sourceId('ft'), use: true, outline: false },
      { id: 'gdi-3d', use: true, outline: false },
      { id: 'dgu', use: false, outline: false },
      { id: 'osm', use: false, outline: false },
    ]);
    await expect(page.locator('#building-sources-summary')).toHaveText('data.example (arcgis) · Zagreb 3D model (GDI)');

    // The source the person added can be removed; the city's cannot.
    await expect(rows.nth(1).getByRole('button', { name: /^Remove/ })).toHaveCount(0);
    await rows.first().getByRole('button', { name: 'Remove data.example (arcgis)' }).click();
    await expect(rows).toHaveCount(3);
    expect((await storedBuildingList(page)).map((entry: any) => entry.id)).toEqual(['gdi-3d', 'dgu', 'osm']);
    expect(await listChanges(page)).toEqual({ samePage: true, changes: 2 });
  });

  test('the building source list editor saves Outline, order and reset at once, with no reload', async ({ mockApi: page }) => {
    await openCity(page);
    await watchListChanges(page);
    await openLayerSection(page, 'buildings');
    const summary = page.locator('#building-sources-summary');
    await expect(summary).toHaveText('Zagreb 3D model (GDI)');
    await page.locator('#building-source-settings-button').click();
    const dialog = page.locator('#parcel-source-settings');
    await expect(dialog.getByRole('heading')).toHaveText('Building sources');
    const rows = dialog.locator('.source-list-editor__row');
    await expect(rows).toHaveText([/Zagreb 3D model \(GDI\)/, /DGU cadastre/, /OpenStreetMap/]);

    // The only source in use cannot be turned off; Outline is for a source not in use.
    const gdi = rows.nth(0), dgu = rows.nth(1);
    await expect(gdi.getByRole('switch', { name: 'Use' })).toBeDisabled();
    await expect(gdi.getByRole('switch', { name: 'Outline' })).toBeDisabled();
    await dgu.getByRole('switch', { name: 'Outline' }).check();
    await expect(dialog.locator('.source-list-editor__row').nth(1).getByRole('switch', { name: 'Outline' })).toBeChecked();
    expect(await storedBuildingList(page)).toEqual([
      { id: 'gdi-3d', use: true, outline: false },
      { id: 'dgu', use: false, outline: true },
      { id: 'osm', use: false, outline: false },
    ]);
    await expect(summary).toHaveText('Zagreb 3D model (GDI) · DGU cadastre outlined');

    // Order: OpenStreetMap up one, then in use.
    await dialog.getByRole('button', { name: 'Move OpenStreetMap up' }).click();
    await expect(rows).toHaveText([/Zagreb 3D model \(GDI\)/, /OpenStreetMap/, /DGU cadastre/]);
    await rows.nth(1).getByRole('switch', { name: 'Use' }).check();
    expect(await storedBuildingList(page)).toEqual([
      { id: 'gdi-3d', use: true, outline: false },
      { id: 'osm', use: true, outline: false },
      { id: 'dgu', use: false, outline: true },
    ]);
    await expect(summary).toHaveText('Zagreb 3D model (GDI) · OpenStreetMap · DGU cadastre outlined');
    // With two in use, either may be turned off.
    await expect(rows.nth(0).getByRole('switch', { name: 'Use' })).toBeEnabled();

    await dialog.getByRole('button', { name: "Reset to the city's list" }).click();
    await expect(rows).toHaveText([/Zagreb 3D model \(GDI\)/, /DGU cadastre/, /OpenStreetMap/]);
    expect(await storedBuildingList(page)).toBeNull();
    await expect(summary).toHaveText('Zagreb 3D model (GDI)');
    expect(await listChanges(page)).toEqual({ samePage: true, changes: 4 });
  });

  test('A building load that fails says so with a retry and the building source list', async ({ mockApi: page }) => {
    // The city's buildings come from its source list, cell by cell; while `fail` is set our server
    // answers every building read with 503, and after it the default fixture answers.
    let fail = true;
    let requests = 0;
    const failing = (route: import('@playwright/test').Route) => {
      const path = new URL(route.request().url()).pathname;
      if (path !== '/buildings' && path !== '/buildings/cell') return route.fallback();
      requests += 1;
      return fail
        ? route.fulfill({ status: 503, headers: { 'Retry-After': '90' }, json: { error: 'Buildings are rate-limited upstream.', retryAfter: 90 } })
        : route.fallback();
    };
    await page.route('**/buildings**', failing);
    await openCity(page);
    await openLayerSection(page, 'buildings');
    await page.locator('#showBuildings').check();
    const banner = page.locator('#building-source-status');
    await expect(banner).toContainText('Our server could not complete the building-data request (HTTP 503).');
    expect(requests).toBeGreaterThan(0);

    await banner.getByRole('button', { name: 'Choose a building source' }).click();
    const dialog = page.locator('#parcel-source-settings');
    await expect(dialog.getByRole('heading')).toHaveText('Building sources');
    await expect(dialog.locator('.source-list-editor__row')).toHaveCount(3);
    await dialog.getByText('Add a source').click();
    await expect(dialog).toContainText('OpenStreetMap mirror');
    await dialog.getByRole('button', { name: 'Close' }).click();

    // A successful building retry must not dismiss a still-failing parcel source.
    await page.evaluate(() => (window as any).fetchParcelData());
    await page.evaluate(() => (window as any).ParcelSourceSettings.reportFailure(window, 'Parcel source is still unavailable.', 'parcel'));
    await expect(page.locator('#parcel-source-status')).toContainText('Parcel source is still unavailable.');
    fail = false;
    const before = requests;
    await banner.getByRole('button', { name: 'Retry buildings' }).click();
    await expect.poll(() => requests).toBeGreaterThan(before);
    await expect(banner).toHaveCount(0);
    await expect(page.locator('#parcel-source-status')).toContainText('Parcel source is still unavailable.');
  });

  test('source warnings identify each layer and clear independently', async ({ mockApi: page }) => {
    await openCity(page);
    // A parcel load that succeeds clears the parcel warning (as it should), so the startup read
    // settles before the warnings are injected. openCity's setView left a debounced map-move read
    // pending; it runs here instead, or on a slow machine it lands after the warnings and clears one.
    await page.evaluate(() => { const w = window as any; clearTimeout(w.parcelsTimeout); return w.fetchParcelData(); });
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
