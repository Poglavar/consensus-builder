// Check ground and parcel controls through real map interactions.
import { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { sampleParcels } from '../helpers/mocks/parcel-data';

// Fail the register at its network boundary; the app must present its real recovery screen.
async function unavailableRegister(page: Page) {
  let failing = true;
  let requests = 0;
  await page.route('**/parcels**', route => {
    const request = route.request();
    if (!['fetch', 'xhr'].includes(request.resourceType()) || request.method() !== 'GET') return route.fallback();
    if (new URL(request.url()).hostname === 'register.example.test') return route.fallback();
    if (!failing) return route.fallback();
    requests++;
    // Explicit retry metadata avoids the real provider's default cooldown; HTTP headers on
    // the cross-origin API are not readable without Access-Control-Expose-Headers.
    return route.fulfill({ status: 503, json: { error: 'Register temporarily unavailable', retryAfterSeconds: 0 } });
  });
  await page.goto('/?city=zg&at=45.80025,15.9822,18&lang=en&reduceMotion=1', { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  await expect(page.locator('.ground-fallback-dialog')).toBeVisible();
  return { count: () => requests, recover: () => { failing = false; } };
}

test('register recovery Close, parcel Refresh, and Retry dismiss, reopen, and recover real data', async ({ mockApi: page }) => {
  const source = await unavailableRegister(page);
  const dialog = page.locator('.ground-fallback-dialog');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.locator('#layers-button').click();
  const beforeRefresh = source.count();
  await page.locator('#refreshParcelDataButton').click();
  await expect.poll(source.count).toBeGreaterThan(beforeRefresh);
  await expect(dialog).toBeVisible();
  source.recover();
  await dialog.locator('[data-option="retry"]').click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).parcelLayer.getLayers().length)).toBeGreaterThan(0);
});

test('register options navigate URL, satellite, and algorithm screens and Not now dismisses them', async ({ mockApi: page }) => {
  await unavailableRegister(page);
  const dialog = page.locator('.ground-fallback-dialog');
  await dialog.locator('[data-option="url"]').click();
  await expect(dialog.locator('.ground-fallback-input')).toBeVisible();
  await dialog.getByRole('button', { name: 'Check and use this link' }).click();
  await expect(dialog.locator('.ground-fallback-result')).toHaveText('That is not a complete URL.');
  await dialog.locator('.ground-fallback-back').click();
  await expect(dialog.locator('.ground-fallback-options')).toBeVisible();
  await dialog.locator('[data-option="ocr"]').click();
  await expect(dialog.locator('.ground-fallback-help')).toContainText('not available from this screen yet');
  await dialog.locator('.ground-fallback-back').click();
  await dialog.locator('[data-option="schelling"]').click();
  await expect(dialog.locator('.ground-fallback-preview svg')).toBeVisible();
  await dialog.locator('.ground-fallback-back').click();
  await dialog.getByRole('button', { name: 'Not now', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('body')).not.toHaveClass(/ground-fallback-open/);
  const banner = page.locator('#parcel-source-status');
  await banner.getByRole('button', { name: 'Choose how to continue' }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await banner.getByRole('button', { name: 'Dismiss source warning' }).click();
  await expect(banner).toHaveCount(0);
});

test('Check and use installs the validated custom register and restores it after navigation', async ({ mockApi: page }) => {
  await page.route('https://register.example.test/parcels.geojson', route => route.fulfill({ json: sampleParcels }));
  await unavailableRegister(page);
  const dialog = page.locator('.ground-fallback-dialog');
  await dialog.locator('[data-option="url"]').click();
  await dialog.locator('.ground-fallback-input').fill('https://register.example.test/parcels.geojson');
  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    dialog.getByRole('button', { name: 'Check and use this link' }).click(),
  ]);
  await waitForMapReady(page);
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).ParcelGroundFallback?.activeSource()?.url).catch(() => null))
    .toBe('https://register.example.test/parcels.geojson');
  await expect.poll(() => page.evaluate(() => (window as any).parcelLayer?.getLayers().length || 0)).toBeGreaterThan(0);
});

test('Draw this plan installs a Schelling source and renders its derived parcels', async ({ mockApi: page }) => {
  await unavailableRegister(page);
  const dialog = page.locator('.ground-fallback-dialog');
  await dialog.locator('[data-option="schelling"]').click();
  await expect(dialog.locator('.ground-fallback-preview svg')).toBeVisible();
  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    dialog.getByRole('button', { name: 'Draw this plan here' }).click(),
  ]);
  await waitForMapReady(page);
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).ParcelGroundFallback?.activeSource()?.kind).catch(() => null)).toBe('schelling');
  await expect.poll(() => page.evaluate(() => (window as any).parcelLayer?.getLayers().length || 0)).toBeGreaterThan(0);
});

test('Explore banner requests its place, opens World view, and dismisses for this session', async ({ mockApi: page }) => {
  const requests: any[] = [];
  await page.route('**/cities/requests', route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/?city=explore&at=23.7104,90.4074,16&lang=en&reduceMotion=1', { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  const banner = page.locator('#explore-banner');
  await expect(banner).toBeVisible();
  await banner.locator('#explore-banner-ask').click();
  await expect(banner.locator('#explore-banner-ask')).toBeDisabled();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({ name: 'Dhaka' });
  await banner.locator('#explore-banner-world').click();
  await expect(page.locator('#world-view')).toBeVisible();
  await page.locator('#world-view').getByRole('button', { name: 'Back to map' }).click();
  await expect(page.locator('#world-view')).toHaveCount(0);
  // This banner's accessible close label is localized as "Close" (the close-circle control),
  // while "Dismiss" belongs to the parcel-source warning banner.
  await banner.locator('.explore-banner__close').click();
  await expect(banner).toHaveCount(0);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  await expect(banner).toHaveCount(0);
});
