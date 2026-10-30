// Starting placement and choosing another city must leave view control with the visitor.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, PARCEL_GEOMETRY, stubBasemapTiles, placeFreeformBuilding } from '../helpers/runtime';
import { waitForMapReady } from '../helpers/app';
import { fileDesign, filePlan, pageIndex } from '../helpers/mocks/shared-server';
import { mockBuildingScene } from '../helpers/mocks/building-data';

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
  await expect(page.locator('#single-building-editor')).toHaveAttribute('data-placing', 'true');
  await expect(page.locator('.single-building-fill--active')).toHaveCount(0);
  await expect(page.locator('.single-building-placement-outline')).toBeVisible();
  const after = await view();
  expect(after.zoom).toBe(before.zoom);
  // Leaflet rounds the center when invalidating its size; retain the same rendered map pixel.
  expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(0.5);
  // Panning the map must not accidentally place a building at the end of the drag.
  await page.mouse.move(400, 300);
  await page.mouse.down();
  await page.mouse.move(425, 310, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('#single-building-editor')).toHaveAttribute('data-placing', 'true');
  // The outline follows the pointer. A headed drag leaves the map gliding (Leaflet inertia), which
  // carries the outline drawn at the last move with it; moving again draws it where the map settled.
  await expect.poll(async () => {
    await page.mouse.move(401, 351);
    await page.mouse.move(400, 350);
    const outline = await page.locator('.single-building-placement-outline').boundingBox();
    return Math.max(Math.abs(outline!.x + outline!.width / 2 - 400), Math.abs(outline!.y + outline!.height / 2 - 350));
  }).toBeLessThan(2);
  await placeFreeformBuilding(page);
  await expect(page.locator('#map-container .single-building-fill--active')).toBeVisible();
  await expect(page.locator('.single-building-label-tooltip')).toHaveCount(0);
  await expect(page.locator('#single-height-slider')).toBeFocused();
});

test('Escape before placing a Freeform leaves no building or saved design', async ({ mockApi: page }) => {
  await stubBasemapTiles(page);
  await openCity(page);
  await openParcel(page, 'proposals');
  const before = await page.evaluate(() => (window as any).proposalStorage.getAllProposals());
  await page.locator('.parcel-build-btn--single').click();
  await expect(page.locator('#single-building-editor')).toHaveAttribute('data-placing', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('#single-building-editor')).toHaveCount(0);
  await expect(page.locator('.single-building-placement-outline')).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).proposalStorage.getAllProposals())).toEqual(before);
});

test.describe('touch Freeform placement', () => {
  test.use({ hasTouch: true, viewport: { width: 500, height: 761 } });
  test('a tap places the building at the touched map location', async ({ mockApi: page }) => {
    await stubBasemapTiles(page);
    await openCity(page);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-build-btn--single').tap();
    await expect(page.locator('#single-building-editor')).toHaveAttribute('data-placing', 'true');
    const at = { x: 250, y: 260 };
    await page.touchscreen.tap(at.x, at.y);
    await expect(page.locator('#single-building-editor')).not.toHaveAttribute('data-placing');
    const center = await page.evaluate(() => {
      const w = window as any;
      const feature = w.OnMapEditor.getPreview().draftPreview.features[0];
      const [lng, lat] = w.turf.centroid(feature).geometry.coordinates;
      const point = w.map.latLngToContainerPoint([lat, lng]);
      const rect = w.map.getContainer().getBoundingClientRect();
      return { x: point.x + rect.left, y: point.y + rect.top };
    });
    expect(Math.abs(center.x - at.x)).toBeLessThan(2);
    expect(Math.abs(center.y - at.y)).toBeLessThan(2);
    await expect(page.locator('.single-building-label-tooltip')).toHaveCount(0);
  });
});

test('Freeform placement works in model view without switching back to the map', async ({ mockApi: page }) => {
  await stubBasemapTiles(page);
  await mockBuildingScene(page);
  await openCity(page);
  await openParcel(page, 'proposals');
  await page.locator('.parcel-build-btn--single').click();
  await page.locator('#mode-3d-toggle').click();
  await expect.poll(() => page.evaluate(() => (window as any).isThreeModeActive?.())).toBe(true);
  const at = { x: 400, y: 300 };
  const expected = await page.evaluate(at => (window as any).getThreeModeInternals().pickGroundLatLng({ clientX: at.x, clientY: at.y }), at);
  await page.mouse.click(at.x, at.y);
  await expect(page.locator('#single-building-editor')).not.toHaveAttribute('data-placing');
  const actual = await page.evaluate(() => {
    const w = window as any;
    return { mode: w.isThreeModeActive(), at: w.SingleBuildingGeometry.geometryCenter(w.OnMapEditor.getPreview().draftPreview.features[0].geometry) };
  });
  expect(actual.mode).toBe(true);
  expect(actual.at.lat).toBeCloseTo(expected.lat, 6);
  expect(actual.at.lng).toBeCloseTo(expected.lng, 6);
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
