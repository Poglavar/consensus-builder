import { test, expect } from '../helpers/fixtures';
import { placeFreeformBuilding, openCity, openParcel, answerBlockScope } from '../helpers/runtime';
import { sampleParcels } from '../helpers/mocks/parcel-data';
import { isApiDataRequest } from '../helpers/mocks/api-routes';
import type { Page } from '@playwright/test';

async function tinyParcel(page: Page) {
  const parcel = structuredClone(sampleParcels.features[0]);
  parcel.geometry.coordinates = [[
    [15.98215, 45.800215], [15.98225, 45.800215],
    [15.98225, 45.800285], [15.98215, 45.800285], [15.98215, 45.800215]
  ]];
  await page.route('**/parcels**', route => isApiDataRequest(route.request().url(), route.request().resourceType(), 'parcels')
    ? route.fulfill({ json: { type: 'FeatureCollection', features: [parcel] } }) : route.continue());
  await openCity(page);
  await openParcel(page, 'proposals');
}

test('a Freeform draft on a tiny parcel preserves the chosen phone view and exposes editable handles', async ({ mockApi: page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await tinyParcel(page);
  const viewBeforeOpening = await page.evaluate(() => {
    const view = (window as any).map;
    return { center: view.getCenter(), zoom: view.getZoom() };
  });
  await page.locator('.parcel-build-btn--single').click();
  await answerBlockScope(page);
  await placeFreeformBuilding(page);
  const footprint = page.locator('.single-building-fill--active');
  await expect(footprint).toBeVisible();
  const dimensions = await page.evaluate(() => {
    const w = window as any;
    const layer = Object.values(w.map._layers).find((item: any) => item._path?.classList.contains('single-building-fill--active')) as any;
    return { area: w.turf.area(layer.feature), height: layer.feature.properties.height };
  });
  expect(dimensions.area).toBeCloseTo(400, 0);
  expect(dimensions.height).toBe(10);
  const viewAfterOpening = await page.evaluate(before => {
    const view = (window as any).map;
    const center = view.getCenter();
    const beforePoint = view.latLngToContainerPoint(before.center);
    const afterPoint = view.latLngToContainerPoint(center);
    return {
      zoom: view.getZoom(),
      centerDisplacementPx: Math.hypot(afterPoint.x - beforePoint.x, afterPoint.y - beforePoint.y),
    };
  }, viewBeforeOpening);
  // Leaflet rounds a center to its pixel grid while the editor redraws layers. The chosen view
  // is still preserved when that projected displacement is below one screen pixel.
  expect(viewAfterOpening.zoom).toBe(viewBeforeOpening.zoom);
  expect(viewAfterOpening.centerDisplacementPx).toBeLessThan(1);
  // The opening sheet initially covers the lower pair of corners. Its keyboard resize control
  // must make those map handles reachable without moving the map or changing the draft.
  const editorPanel = page.locator('#single-building-editor .on-map-editor__panel');
  const sheetHandle = editorPanel.locator(':scope > .mobile-dock-sheet-handle');
  await expect(sheetHandle).toBeVisible();
  await sheetHandle.focus();
  await page.keyboard.press('Home');
  await expect.poll(async () => (await editorPanel.boundingBox())?.height || Infinity).toBeLessThan(300);
  const beforeVertexEdit = await page.evaluate(() => {
    const layer = Object.values((window as any).map._layers)
      .find((item: any) => item._path?.classList?.contains('single-building-fill--active')) as any;
    return layer.feature.geometry.coordinates;
  });
  const vertex = page.locator('#map-container .polygon-geometry-editor__vertex').first();
  await expect(page.locator('#map-container .polygon-geometry-editor__vertex')).toHaveCount(4);
  const vertexBox = await vertex.boundingBox();
  if (!vertexBox) throw new Error('Tiny-parcel Freeform vertex handle is not visible');
  await page.mouse.move(vertexBox.x + vertexBox.width / 2, vertexBox.y + vertexBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(vertexBox.x + vertexBox.width / 2 + 8, vertexBox.y + vertexBox.height / 2 - 8, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(before => {
    const layer = Object.values((window as any).map._layers)
      .find((item: any) => item._path?.classList?.contains('single-building-fill--active')) as any;
    return JSON.stringify(layer.feature.geometry.coordinates) !== JSON.stringify(before);
  }, beforeVertexEdit)).toBe(true);
  const box = await footprint.boundingBox();
  if (!box) throw new Error('Tiny-parcel Freeform footprint is not visible');
  const rotation = await page.locator('#single-building-editor .on-map-editor__tools').boundingBox();
  expect(rotation!.y).toBeGreaterThan(box.y + box.height + 12);
  await expect(page.locator('#single-building-confirm')).toBeEnabled();
  const vertexControls = page.locator('#single-building-editor details.geometry-controls');
  await expect(vertexControls).toBeVisible();
  await expect(vertexControls.locator('summary')).toHaveText('Outline 1 vertices');
  await vertexControls.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(vertexControls.getByLabel('Latitude')).toBeVisible();
  await expect(vertexControls.getByLabel('Longitude')).toBeVisible();
  await expect(page.locator('#single-ground-treatment')).toBeVisible();
  const parcelChoice = page.locator('#single-land-take [data-parcel-id]');
  await expect.poll(() => parcelChoice.count()).toBeGreaterThan(0);
});

test('Freeform can be placed on selected land with the keyboard', async ({ mockApi: page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await tinyParcel(page);
  const view = await page.evaluate(() => ({ center: (window as any).map.getCenter(), zoom: (window as any).map.getZoom() }));
  await page.locator('.parcel-build-btn--single').click();
  await answerBlockScope(page);
  const place = page.getByRole('button', { name: 'Place on selected land' });
  await expect(place).toBeVisible();
  await expect(place).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(place).toHaveCount(0);
  await expect(page.locator('.single-building-fill--active')).toHaveCount(1);
  await expect(page.locator('#single-height-slider')).toBeFocused();
  const viewAfter = await page.evaluate(before => {
    const map = (window as any).map;
    const start = map.latLngToContainerPoint(before.center), end = map.latLngToContainerPoint(map.getCenter());
    return { zoom: map.getZoom(), displacement: Math.hypot(end.x - start.x, end.y - start.y) };
  }, view);
  expect(viewAfter.zoom).toBe(view.zoom);
  expect(viewAfter.displacement).toBeLessThan(1);
  await expect(page.locator('[data-land-status]')).toContainText('m²');
  await page.locator('#single-building-confirm').click();
  await expect(page.locator('#single-building-editor')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().filter((p: any) => p.goal === 'single' && p.geometry?.buildings?.length === 1).length), { timeout: 20_000 }).toBe(1);
});

test('site drawing cancellation restores keyboard focus', async ({ mockApi: page }) => {
  await openCity(page);
  await page.evaluate(() => { const w = window as any; w.map.getContainer().focus(); w.SiteTool.start(); });
  await expect(page.locator('#site-panel summary')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#site-panel')).toBeHidden();
  await expect(page.locator('#map')).toBeFocused();
});

test('cancelling parcel scope never creates a design, while choosing the parcel does', async ({ mockApi: page }) => {
  await tinyParcel(page);
  const tile = page.locator('.parcel-build-btn--park');
  const designs = () => page.evaluate(() => (window as any).proposalStorage.getAllProposals().length);
  expect(await designs()).toBe(0);
  await tile.click();
  const choice = page.getByRole('alertdialog');
  await expect(choice.getByRole('button', { name: 'Use this parcel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(choice).toBeHidden();
  expect(await designs()).toBe(0);
  await expect(tile).toBeFocused();
  await tile.click();
  await choice.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(choice).toBeHidden();
  expect(await designs()).toBe(0);
  await tile.click();
  await choice.getByRole('button', { name: 'Use this parcel' }).click();
  await expect.poll(designs).toBe(1);
});

test('Block always offers its scope choice and explains when default settings do not fit', async ({ mockApi: page }) => {
  await tinyParcel(page);
  await page.locator('.parcel-build-btn--buildings').click();
  const choice = page.getByRole('alertdialog');
  await expect(choice).toContainText('detect the whole block');
  await choice.getByRole('button', { name: 'Use this parcel' }).click();
  const warning = page.locator('#blockify-fit-warning');
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('too small');
  await expect(page.locator('#btn-blockify-done')).toBeDisabled();
  for (const id of ['setback-slider', 'width-slider', 'blockify-minplot-slider']) {
    await page.locator(`#${id}`).focus();
    await page.keyboard.press('Home');
    if (id === 'width-slider') { await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); }
  }
  await expect(warning).toBeHidden();
  await expect(page.locator('#btn-blockify-done')).toBeEnabled();
});
