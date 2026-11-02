import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel } from '../helpers/runtime';
import { installLayerDatasets, TEST_PARCEL_ID } from '../helpers/mocks/layer-datasets';
import { ensurePageIndex } from '../helpers/mocks/shared-server';

const SEED_ID = TEST_PARCEL_ID;
const BLOCK_PARCEL_IDS = ['HR-335754-1234', 'HR-335754-1235', 'HR-335754-1236', 'HR-335754-1237', 'HR-335754-1238'];

function enclosureFeatures(boundary: Record<string, string>) {
  const west = 15.98204, east = 15.98236, south = 45.80019, north = 45.80055;
  const edges = [
    [[west, south], [east, south]], [[east, south], [east, north]],
    [[east, north], [west, north]], [[west, north], [west, south]],
  ];
  return edges.map((coordinates, index) => ({ type: 'Feature', id: `boundary-${index}`,
    properties: { ...boundary }, geometry: { type: 'LineString', coordinates } }));
}

async function installBoundaries(page: any, boundary: Record<string, string> | null) {
  await page.route('**/blocks/roads?**', async (route: any) => {
    if (!['fetch', 'xhr'].includes(route.request().resourceType())) return route.fallback();
    await route.fulfill({ json: { type: 'FeatureCollection', complete: boundary !== null,
      features: boundary ? enclosureFeatures(boundary) : [] } });
  });
}

function denseParcels() {
  const parcels = [] as any[];
  for (let row = 0; row < 10; row++) for (let column = 0; column < 11; column++) {
    const west = 15.982051 + column * 0.000027;
    const south = 45.800201 + row * 0.000033;
    const id = row === 1 && column === 5 ? SEED_ID : `E2E-BLOCK-${row}-${column}`;
    parcels.push({ type: 'Feature', id, properties: { parcelId: id, parcel_id: id, id },
      geometry: { type: 'Polygon', coordinates: [[[west, south], [west + 0.000027, south],
        [west + 0.000027, south + 0.000027], [west, south + 0.000027], [west, south]]] } });
  }
  return parcels;
}

async function serveDenseParcels(page: any) {
  const features = denseParcels();
  (await ensurePageIndex(page)).cadastre = features;
  await page.route('**/parcels**', async (route: any) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET') return route.fallback();
    if (url.pathname.endsWith('/parcels/parcelIds')) {
      const requested = new Set(url.searchParams.get('ids')?.split(',') ?? []);
      return route.fulfill({ json: { type: 'FeatureCollection', features: features.filter(feature => requested.has(feature.id)) } });
    }
    if (url.pathname.endsWith('/parcels')) {
      return route.fulfill({ json: { type: 'FeatureCollection', features } });
    }
    return route.fallback();
  });
}

async function beginSeedSelection(page: any) {
  await openParcel(page, 'design', SEED_ID);
  await page.locator('#parcel-manual-selection').click();
  const selected = () => page.evaluate(() => [...(window as any).multiParcelSelection.selectedParcels].sort());
  await expect.poll(selected).toEqual([SEED_ID]);
  return selected;
}

test('over-limit block previews exactly 100 paths and Escape/OK clear them without changing selection at 360px', async ({ mockApi: page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await installLayerDatasets(page);
  await serveDenseParcels(page);
  await openCity(page, SEED_ID);
  const selected = await beginSeedSelection(page);
  const before = await selected();
  const detect = page.locator('.click-stack__section[data-kind="selection"] .multi-select-detect-btn');

  await detect.focus();
  await detect.press('Enter');
  const dialog = page.locator('.block-detection-preview-dialog');
  const preview = page.locator('.block-detection-preview');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^OK$/i })).toBeFocused();
  await expect(preview).toHaveCount(100);
  expect(await selected()).toEqual(before);
  expect(page.viewportSize()?.width).toBe(360);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(preview).toHaveCount(0);
  await expect(detect).toBeFocused();
  expect(await selected()).toEqual(before);

  await detect.press('Enter');
  await expect(dialog).toBeVisible();
  await expect(preview).toHaveCount(100);
  await dialog.getByRole('button', { name: /^OK$/i }).click();
  await expect(dialog).toBeHidden();
  await expect(preview).toHaveCount(0);
  expect(await selected()).toEqual(before);
});

for (const [name, boundary] of [['rail', { railway: 'rail' }], ['stream', { waterway: 'stream' }]] as const) {
  test(`selects the real enclosed parcel block from ${name} boundaries`, async ({ mockApi: page }) => {
    await installLayerDatasets(page);
    await installBoundaries(page, boundary);
    await openCity(page);
    await openParcel(page, 'design', SEED_ID);
    await page.locator('#parcel-info-panel .multi-select-detect-btn').click();
    await expect.poll(() => page.evaluate(() => [...(window as any).multiParcelSelection.selectedParcels].sort()))
      .toEqual(BLOCK_PARCEL_IDS.slice().sort());
    await expect(page.locator('.block-detection-preview')).toHaveCount(0);
  });
}

test('incomplete boundary data shows a clear alert and leaves the selection unchanged', async ({ mockApi: page }) => {
  await installLayerDatasets(page);
  await installBoundaries(page, null);
  await openCity(page);
  const selected = await beginSeedSelection(page);
  const before = await selected();
  await page.locator('.click-stack__section[data-kind="selection"] .multi-select-detect-btn').click();
  const alert = page.getByRole('alertdialog');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(/complete OSM roads|boundary coverage is incomplete/i);
  expect(await selected()).toEqual(before);
  await expect(page.locator('.block-detection-preview')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(alert).toBeHidden();
  expect(await selected()).toEqual(before);
});
