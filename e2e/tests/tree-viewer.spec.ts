// Exercise the standalone tree viewer's controls and failure recovery with bounded source fixtures.
import { test, expect } from '@playwright/test';

const data = { type: 'FeatureCollection', features: [
  { type: 'Feature', geometry: { type: 'Point', coordinates: [15.9873677, 45.8007523] }, properties: { sifra: 101 } }
] };
const path = '/trees.html?backend=/tree-api&city=zagreb&at=45.8007523,15.9873677&zoom=18';

test('tree inspection, visibility and failed refresh recovery', async ({ page }) => {
  const errors: Error[] = [];
  page.on('pageerror', error => errors.push(error));
  let failed = false;
  await page.route('**/tree-api/trees?*', route => route.fulfill({
    status: failed ? 502 : 200, contentType: 'application/json',
    body: JSON.stringify(failed ? { error: 'Tree service unavailable.' } : data)
  }));
  await page.goto(path);
  await expect(page.getByRole('status')).toHaveText('1 tree in this view');
  await page.getByRole('button', { name: 'Tree 101', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tree #101' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Zrinjevac map' })).toHaveAttribute('href', 'https://gis.zrinjevac.hr/');
  await page.getByLabel('Tree locations', { exact: true }).uncheck();
  await expect(page.getByRole('status')).toHaveText('Tree layer hidden.');
  await expect(page.locator('.tree-marker')).toHaveCount(0);
  await page.getByLabel('Tree locations', { exact: true }).check();
  await expect(page.locator('.tree-marker')).toHaveCount(1);
  failed = true;
  await page.getByRole('button', { name: 'Refresh trees' }).click();
  await expect(page.getByRole('status')).toContainText('Tree service unavailable.');
  await expect(page.locator('.tree-marker')).toHaveCount(0);
  await expect(page.locator('#refresh')).not.toHaveAttribute('aria-busy');
  failed = false;
  await page.getByRole('button', { name: 'Refresh trees' }).click();
  await expect(page.locator('.tree-marker')).toHaveCount(1);
  await expect(page.getByRole('status')).toHaveText('1 tree in this view');
  expect(errors).toEqual([]);
});

test('phone layout and returning to the requested area', async ({ page }) => {
  const errors: Error[] = [];
  page.on('pageerror', error => errors.push(error));
  await page.setViewportSize({ width: 390, height: 844 });
  const boxes: string[] = [];
  await page.route('**/tree-api/trees?*', route => {
    boxes.push(new URL(route.request().url()).searchParams.get('bbox')!);
    return route.fulfill({ json: data });
  });
  await page.goto(path.replace('45.8007523,15.9873677', '45.81,15.99'));
  await expect(page.getByRole('status')).toHaveText('No inventoried trees in this view.');
  await page.getByRole('button', { name: 'Your area' }).click();
  await expect(page.getByRole('status')).toHaveText('1 tree in this view');
  await expect(page.locator('#reset')).not.toHaveAttribute('aria-busy');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  const [west, south, east, north] = boxes.at(-1)!.split(',').map(Number);
  expect((west + east) / 2).toBeCloseTo(15.9873677, 4);
  expect((south + north) / 2).toBeCloseTo(45.8007523, 4);
  expect(errors).toEqual([]);
});
