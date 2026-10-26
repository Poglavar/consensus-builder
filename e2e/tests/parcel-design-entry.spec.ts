import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel } from '../helpers/runtime';
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
  await expect(page.locator('#single-building-editor details')).toHaveCount(0);
  await expect(page.locator('#single-ground-treatment')).toBeVisible();
  const parcelChoice = page.locator('#single-land-take [data-parcel-id]');
  await expect.poll(() => parcelChoice.count()).toBeGreaterThan(0);
});

test('Block always offers its scope choice and explains when default settings do not fit', async ({ mockApi: page }) => {
  await tinyParcel(page);
  await page.locator('.parcel-build-btn--buildings').click();
  const choice = page.getByRole('alertdialog');
  await expect(choice).toContainText('detect the whole block');
  await choice.getByRole('button', { name: 'No, just this parcel' }).click();
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
