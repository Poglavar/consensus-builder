// Starting placement and choosing another city must leave view control with the visitor.
import { test, expect } from '../helpers/fixtures';
import type { Page } from '@playwright/test';
import { openCity, openParcel, PARCEL_GEOMETRY, stubBasemapTiles, placeFreeformBuilding, freeformBuildingPlaced, answerBlockScope } from '../helpers/runtime';
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
  await answerBlockScope(page);
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
  await answerBlockScope(page);
  await expect(page.locator('#single-building-editor')).toHaveAttribute('data-placing', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('#single-building-editor')).toHaveCount(0);
  await expect(page.locator('.single-building-placement-outline')).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).proposalStorage.getAllProposals())).toEqual(before);
});

test.describe('touch Freeform editor', () => {
  // A phone: no hover and a coarse pointer, so nothing is carried and the building stands on the land.
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 761 } });
  test('the building opens on the selected land, a tap elsewhere leaves it, and a finger drags it', async ({ mockApi: page }) => {
    await stubBasemapTiles(page);
    await openCity(page);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-build-btn--single').tap();
    await answerBlockScope(page);
    await freeformBuildingPlaced(page);
    const placed = await placedBuilding(page);
    expect(placed.count).toBe(1);
    expect(placed.center.lat).toBeCloseTo(placed.sitePoint.lat, 6);
    expect(placed.center.lng).toBeCloseTo(placed.sitePoint.lng, 6);
    // The footprint is in view, above the editor sheet, so the finger can reach it.
    const footprint = await page.locator('#map-container .single-building-fill--active').boundingBox();
    const sheet = await page.locator('#single-building-editor .on-map-editor__panel').boundingBox();
    expect(footprint!.y).toBeGreaterThanOrEqual(0);
    expect(footprint!.y + footprint!.height / 2).toBeLessThan(sheet!.y);
    // A tap on open map away from the footprint is not a place command.
    const away = { x: footprint!.x + footprint!.width / 2, y: footprint!.y > 140 ? footprint!.y - 60 : footprint!.y + footprint!.height + 60 };
    await page.touchscreen.tap(away.x, away.y);
    const after = await placedBuilding(page);
    expect(after.count).toBe(1);
    expect(after.center.lat).toBeCloseTo(placed.center.lat, 9);
    expect(after.center.lng).toBeCloseTo(placed.center.lng, 9);
    // A finger drag from inside the footprint moves the building over the ground, not the map under it.
    const mapCenter = () => page.evaluate(() => (window as any).map.getCenter());
    const centerBefore = await mapCenter();
    const from = { x: footprint!.x + footprint!.width / 2, y: footprint!.y + footprint!.height / 2 };
    const touchAt = (type: string, x: number, y: number) => cdp.send('Input.dispatchTouchEvent', {
      type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
    const cdp = await page.context().newCDPSession(page);
    await touchAt('touchStart', from.x, from.y);
    for (let step = 1; step <= 8; step++) await touchAt('touchMove', from.x + step * 4, from.y + step * 3);
    await touchAt('touchEnd', 0, 0);
    // The finger went 32 px east and 24 px south: the building follows on the ground.
    await expect.poll(async () => {
      const moved = await placedBuilding(page);
      return moved.center.lng > after.center.lng && moved.center.lat < after.center.lat;
    }).toBe(true);
    expect(await mapCenter()).toEqual(centerBefore);
    await expect(page.locator('.single-building-label-tooltip')).toHaveCount(0);
  });
});

test('Freeform placement works in model view without switching back to the map', async ({ mockApi: page }) => {
  await stubBasemapTiles(page);
  await mockBuildingScene(page);
  await openCity(page);
  await openParcel(page, 'proposals');
  await page.locator('.parcel-build-btn--single').click();
  await answerBlockScope(page);
  await page.locator('#mode-3d-toggle').click();
  // The 3D toggle remains pressed while its scene is loading.  Do not send the placement click
  // into that transition: it belongs to the Leaflet map until the model canvas takes ownership.
  await expect(page.locator('#mode-3d-toggle')).not.toHaveClass(/mode-btn-loading/, { timeout: 20_000 });
  await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => (window as any).isThreeModeActive?.()), { timeout: 20_000 }).toBe(true);
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
