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

test('a Freeform draft on a tiny parcel keeps a usable footprint on a phone', async ({ mockApi: page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await tinyParcel(page);
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
  const box = await footprint.boundingBox();
  expect(Math.min(box!.width, box!.height)).toBeGreaterThan(60);
  const rotation = await page.locator('#single-building-editor .on-map-editor__tools').boundingBox();
  expect(rotation!.y).toBeGreaterThan(box!.y + box!.height + 12);
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
