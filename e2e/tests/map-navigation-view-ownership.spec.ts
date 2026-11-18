// Opening the Freeform editor and choosing another city must leave view control with the visitor.
import { test, expect } from '../helpers/fixtures';
import type { Page } from '@playwright/test';
import { openCity, openParcel, PARCEL_GEOMETRY, stubBasemapTiles, freeformBuildingPlaced, answerBlockScope } from '../helpers/runtime';
import { waitForMapReady } from '../helpers/app';
import { fileDesign, filePlan, pageIndex } from '../helpers/mocks/shared-server';
import { mockBuildingScene } from '../helpers/mocks/building-data';

const records = require('../../frontend/js/design-record.js');
const plans = require('../../frontend/js/plan-record.js');
test.use({ navigationTimeout: 60_000 });

// The edited building's centre and the point inside the draft's starting site it opens on.
const placedBuilding = (page: Page) => page.evaluate(() => {
  const w = window as any;
  const site = w.getActiveProposalDesignDraft()?.fields?.site;
  const siteFeature = site?.type === 'Feature' ? site : w.turf.feature(site);
  const [siteLng, siteLat] = w.turf.pointOnFeature(siteFeature).geometry.coordinates;
  const features = w.OnMapEditor.getPreview().draftPreview.features;
  return {
    count: features.length,
    center: w.SingleBuildingGeometry.geometryCenter(features[0].geometry),
    sitePoint: { lat: siteLat, lng: siteLng }
  };
});

test('opening Freeform keeps the map center and zoom and stands the building on the selected land', async ({ mockApi: page }) => {
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
  await answerBlockScope(page);
  await freeformBuildingPlaced(page);
  const after = await view();
  expect(after.zoom).toBe(before.zoom);
  // Leaflet rounds the center when invalidating its size; retain the same rendered map pixel.
  expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(0.5);
  const placed = await placedBuilding(page);
  expect(placed.count).toBe(1);
  expect(placed.center.lat).toBeCloseTo(placed.sitePoint.lat, 6);
  expect(placed.center.lng).toBeCloseTo(placed.sitePoint.lng, 6);
  await expect(page.locator('.single-building-label-tooltip')).toHaveCount(0);
  await expect(page.locator('#single-height-slider')).toBeFocused();
});

test('Escape on a just-opened Freeform leaves no building or saved design', async ({ mockApi: page }) => {
  await stubBasemapTiles(page);
  await openCity(page);
  await openParcel(page, 'proposals');
  const before = await page.evaluate(() => (window as any).proposalStorage.getAllProposals());
  await page.locator('.parcel-build-btn--single').click();
  await answerBlockScope(page);
  await freeformBuildingPlaced(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('#single-building-editor')).toHaveCount(0);
  await expect(page.locator('#map-container .single-building-fill')).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).proposalStorage.getAllProposals())).toEqual(before);
});

test.describe('touch Freeform editor', () => {
  test.use({ hasTouch: true, viewport: { width: 500, height: 761 } });
  test('the building opens on the selected land and a tap on the map does not move it', async ({ mockApi: page }) => {
    await stubBasemapTiles(page);
    await openCity(page);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-build-btn--single').tap();
    await answerBlockScope(page);
    await freeformBuildingPlaced(page);
    const placed = await placedBuilding(page);
    expect(placed.center.lat).toBeCloseTo(placed.sitePoint.lat, 6);
    expect(placed.center.lng).toBeCloseTo(placed.sitePoint.lng, 6);
    // A tap on open map away from the footprint is not a place command.
    const away = await page.evaluate(() => {
      const w = window as any;
      const box = w.map.getContainer().getBoundingClientRect();
      const footprint = document.querySelector('#map-container .single-building-fill--active')!.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = footprint.top - 60 > box.top + 20 ? footprint.top - 60 : footprint.bottom + 60;
      return { x, y };
    });
    await page.touchscreen.tap(away.x, away.y);
    const after = await placedBuilding(page);
    expect(after.count).toBe(1);
    expect(after.center.lat).toBeCloseTo(placed.center.lat, 9);
    expect(after.center.lng).toBeCloseTo(placed.center.lng, 9);
    await expect(page.locator('.single-building-label-tooltip')).toHaveCount(0);
  });
});

test('the placed Freeform building stays where it stands when the editor switches to model view', async ({ mockApi: page }) => {
  await stubBasemapTiles(page);
  await mockBuildingScene(page);
  await openCity(page);
  await openParcel(page, 'proposals');
  await page.locator('.parcel-build-btn--single').click();
  await answerBlockScope(page);
  await freeformBuildingPlaced(page);
  const placed = await placedBuilding(page);
  await page.locator('#mode-3d-toggle').click();
  await expect(page.locator('#mode-3d-toggle')).not.toHaveClass(/mode-btn-loading/, { timeout: 20_000 });
  await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => (window as any).isThreeModeActive?.()), { timeout: 20_000 }).toBe(true);
  await expect(page.locator('#single-building-editor .on-map-editor__panel')).toBeVisible();
  await expect(page.locator('#single-building-confirm')).toBeEnabled();
  const actual = await placedBuilding(page);
  expect(actual.count).toBe(1);
  expect(actual.center.lat).toBeCloseTo(placed.center.lat, 9);
  expect(actual.center.lng).toBeCloseTo(placed.center.lng, 9);
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
