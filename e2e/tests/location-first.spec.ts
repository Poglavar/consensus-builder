// Location first (location-first.md phase 1): the address's ?at= decides which city the app boots
// in, a ?city= beside it is ignored and dropped, ?city= alone opens that city at its centre, and a
// point no city's parcels reach opens explore. Asserted on the booted city, the address and the
// parcel requests the city's sources make.
import { test, expect } from '../helpers/fixtures';
import { waitForMapReady, getMapCenter } from '../helpers/app';

const ZAGREB_AT = '45.81305,15.97060,18';
const MANHATTAN_AT = '40.74840,-73.98570,17';

function recordRequests(page: import('@playwright/test').Page) {
  const urls: string[] = [];
  page.on('request', request => urls.push(request.url()));
  return urls;
}

async function bootState(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = window as any;
    const url = new URL(window.location.href);
    return {
      cityId: w.CityConfigManager.getCurrentCityId(),
      entry: w.CityConfigManager.getBootEntry(),
      cityParam: url.searchParams.get('city'),
      at: url.searchParams.get('at'),
    };
  });
}

test.describe('Location first @core', () => {
  test('a Zagreb ?at= boots Zagreb over a stored New York and asks no New York source', async ({ mockApi: page }) => {
    const requests = recordRequests(page);
    await page.goto(`/?at=${ZAGREB_AT}&lang=en`);
    await waitForMapReady(page);
    const state = await bootState(page);
    expect(state.cityId).toBe('zagreb');
    expect(state.entry.source).toBe('at');
    expect(state.cityParam).toBeNull();
    const [lat, lon] = await getMapCenter(page);
    expect(lat).toBeCloseTo(45.81305, 3);
    expect(lon).toBeCloseTo(15.9706, 3);
    expect(requests.filter(url => url.includes('/parcel-nyc') && !/\.(js|css)(\?|$)/.test(url))).toEqual([]);
    expect(await page.evaluate(() => (window as any).BrowserWorkspace.storage.getItem('cb_current_city'))).toBe('zagreb');
  });

  test('?at= wins over a contradicting ?city=, which is logged and dropped from the address', async ({ mockApi: page }) => {
    const logs: string[] = [];
    page.on('console', message => logs.push(message.text()));
    await page.goto(`/?city=zagreb&at=${MANHATTAN_AT}&lang=en`);
    await waitForMapReady(page);
    const state = await bootState(page);
    expect(state.cityId).toBe('new_york');
    expect(state.entry.ignoredCity).toBe('zagreb');
    await expect.poll(async () => (await bootState(page)).cityParam).toBeNull();
    expect(logs.some(line => line.includes('city=zagreb ignored: at= lies in new_york'))).toBe(true);
  });

  test('?city= alone opens that city at its centre and the address becomes a plain location', async ({ mockApi: page }) => {
    await page.goto('/?city=zg&lang=en');
    await waitForMapReady(page);
    const state = await bootState(page);
    expect(state.cityId).toBe('zagreb');
    expect(state.entry.source).toBe('city');
    await expect.poll(async () => (await bootState(page)).cityParam).toBeNull();
    const after = await bootState(page);
    expect(after.at).toMatch(/^45\.8\d+,15\.9\d+,\d+$/);
  });

  test('a point no city covers opens explore there, with no parcel requests', async ({ mockApi: page }) => {
    const requests = recordRequests(page);
    await page.goto('/?at=30,-40,6&lang=en');
    await waitForMapReady(page);
    const state = await bootState(page);
    expect(state.cityId).toBe('explore');
    expect(await page.evaluate(() => (window as any).CityConfigManager.isExplore())).toBe(true);
    const [lat, lon] = await getMapCenter(page);
    // at zoom 6 Leaflet rounds the centre to whole pixels (~0.01°)
    expect(lat).toBeCloseTo(30, 1);
    expect(lon).toBeCloseTo(-40, 1);
    const parcelApi = requests.filter(url => !/\.(js|css)(\?|$)/.test(url) && /\/parcel(s|-nyc|-ba|-bg|-co|-lj|-sources)\b/.test(url));
    expect(parcelApi).toEqual([]);
    // exploring is not choosing a city: the stored pointer stays
    expect(await page.evaluate(() => (window as any).BrowserWorkspace.storage.getItem('cb_current_city'))).toBe('new_york');
  });

  test('a record link still opens in the city it names', async ({ mockApi: page }) => {
    await page.goto(`/?city=zagreb&focusProposal=999999&at=${MANHATTAN_AT}&lang=en`);
    await page.waitForFunction(() => !!(window as any).CityConfigManager);
    const state = await bootState(page);
    expect(state.cityId).toBe('zagreb');
    expect(state.entry.source).toBe('record');
  });
});
