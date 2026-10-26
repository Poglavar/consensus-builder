// Starting placement and choosing another city must leave view control with the visitor.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, PARCEL_GEOMETRY, stubBasemapTiles } from '../helpers/runtime';
import { waitForMapReady } from '../helpers/app';
import { fileDesign, filePlan, pageIndex } from '../helpers/mocks/shared-server';

const records = require('../../frontend/js/design-record.js');
const plans = require('../../frontend/js/plan-record.js');
test.use({ navigationTimeout: 60_000 });

test('opening Freeform placement preserves the map center and zoom', async ({ mockApi: page }) => {
  await stubBasemapTiles(page);
  await openCity(page);
  await openParcel(page, 'proposals');
  const view = () => page.evaluate(() => {
    const map = (window as any).map, center = map.getCenter();
    const point = map.project(center);
    return { x: point.x, y: point.y, zoom: map.getZoom() };
  });
  const before = await view();

  await page.locator('#parcel-info-panel .parcel-build-btn--single').click();
  await expect(page.locator('#single-building-editor .on-map-editor__panel')).toBeVisible();
  await expect(page.locator('#single-height-slider')).toBeFocused();
  const after = await view();
  expect(after.zoom).toBe(before.zoom);
  // Leaflet rounds the center when invalidating its size; retain the same rendered map pixel.
  expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(0.5);
  await expect(page.locator('#map-container .single-building-fill--active')).toBeVisible();
});

test('city search from a loaded named plan leaves its route and camera behind', async ({ mockApi: page }) => {
  await stubBasemapTiles(page);
  await page.route('https://photon.komoot.io/api/**', route => route.fulfill({ json: { features: [] } }));
  const index = pageIndex(page);
  const design = fileDesign(index, records.published({
    city: 'zg', title: 'Origin city garden', goal: 'park', site: PARCEL_GEOMETRY,
    structureProposal: { kind: 'park', geometry: PARCEL_GEOMETRY }, createdAt: '2026-10-26T10:00:00Z'
  }));
  const plan = filePlan(index, plans.create('Origin city plan', [design], {
    at: '45.80025,15.9822,18', mode: '2d', city: 'zagreb', language: 'en'
  }));
  await page.goto(`/plans/${plan}?city=zg&lang=en&reduceMotion=1&camera=45.8,15.98,0,-0.8,500&rotate=1`, { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  await expect.poll(() => page.evaluate(cid => {
    const w = window as any;
    return w.proposalStorage?.getAllProposals().some((record: any) => w.isApplied(record) && w.DesignSync.publishedCid(record) === cid);
  }, design), { timeout: 30_000 }).toBe(true);
  const planReads = () => index.requests.filter(request => request.method === 'GET' && request.path === `/plans/${plan}`).length;
  const readsBeforeLeaving = planReads();

  await page.locator('.map-search__icon-button').click();
  await page.locator('#map-search-input').fill('Belgrade');
  const city = page.locator('.map-search__results [role="option"]').filter({ hasText: /^Belgrade/ }).first();
  await expect(city).toBeVisible();
  await Promise.all([
    page.waitForURL(url => url.pathname === '/' && url.searchParams.get('city') === 'belgrade'),
    city.click()
  ]);
  await waitForMapReady(page);
  await expect.poll(() => page.evaluate(() => (window as any).CityConfigManager.getCurrentCityId())).toBe('belgrade');
  const destination = new URL(page.url());
  for (const key of ['camera', 'rotate', 'planningSelection']) expect(destination.searchParams.has(key), key).toBe(false);
  expect(destination.pathname).toBe('/');
  expect(planReads()).toBe(readsBeforeLeaving);
  const center = await page.evaluate(() => {
    const center = (window as any).map.getCenter();
    return [center.lat, center.lng];
  });
  expect(center[0]).toBeCloseTo(44.8, 0);
  expect(center[1]).toBeCloseTo(20.4, 0);
});
