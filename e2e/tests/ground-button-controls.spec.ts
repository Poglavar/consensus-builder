import { openLayerSection } from '../helpers/layers';
// Check ground and parcel controls through real map interactions.
import { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { stubBasemapTiles } from '../helpers/runtime';
import { sampleParcels } from '../helpers/mocks/parcel-data';
import { surveyResponse } from '../helpers/mocks/survey-data';

const DGU_WFS = 'https://oss.uredjenazemlja.hr/OssWebServices/wfs**';

// Fail the register at its network boundary — our server's copy and DGU's own WFS, which the
// browser reads directly when our server is down; the app must present its real recovery screen.
async function unavailableRegister(page: Page) {
  let failing = true;
  let requests = 0;
  await page.route(DGU_WFS, route => (failing
    ? route.fulfill({ status: 503, body: 'DGU unavailable' })
    : route.fallback()));
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

test("with our server down, Zagreb's parcels come straight from DGU's WFS and the recovery screen stays shut", async ({ mockApi: page }) => {
  const dgu: string[] = [];
  await page.route('**/parcels**', route => {
    const request = route.request();
    if (!['fetch', 'xhr'].includes(request.resourceType()) || request.method() !== 'GET') return route.fallback();
    return route.fulfill({ status: 503, json: { error: 'Server down', retryAfterSeconds: 0 } });
  });
  // DGU's wire shape: DKP_CESTICE properties in upper case, EPSG:3765 coordinates.
  await page.route(DGU_WFS, route => {
    dgu.push(route.request().url());
    const features = sampleParcels.features.map((feature, index) => ({
      type: 'Feature', id: `DKP_CESTICE.${900 + index}`, geometry: feature.geometry,
      properties: { CESTICA_ID: 900 + index, MATICNI_BROJ_KO: Number(feature.properties.maticni_broj_ko), BROJ_CESTICE: String(feature.properties.parcel_number) },
    }));
    return route.fulfill({ json: { ...surveyResponse(features), totalFeatures: features.length } });
  });
  await page.goto('/?city=zg&at=45.80025,15.9822,18&lang=en&reduceMotion=1', { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  await expect.poll(() => page.evaluate(() => (window as any).parcelLayer?.getLayers().length || 0)).toBeGreaterThan(0);
  const ids = await page.evaluate(() => (window as any).parcelLayer.getLayers().map((layer: any) => layer.feature?.properties?.parcelId).sort());
  expect(ids).toContain(`HR-${sampleParcels.features[0].properties.maticni_broj_ko}-${sampleParcels.features[0].properties.parcel_number}`);
  expect(dgu.length).toBeGreaterThan(0);
  await expect(page.locator('.ground-fallback-dialog')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).ParcelSourceInView.latest().detail)).toEqual({ liveHost: 'oss.uredjenazemlja.hr' });
});

test('register recovery Close, parcel Refresh, and Retry dismiss, reopen, and recover real data', async ({ mockApi: page }) => {
  const source = await unavailableRegister(page);
  const dialog = page.locator('.ground-fallback-dialog');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await openLayerSection(page, 'parcels');
  const beforeRefresh = source.count();
  await page.locator('#refreshParcelDataButton').click();
  await expect.poll(source.count).toBeGreaterThan(beforeRefresh);
  await expect(dialog).toBeVisible();
  source.recover();
  await dialog.locator('[data-option="retry"]').click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).parcelLayer.getLayers().length)).toBeGreaterThan(0);
});

test('register URL recovery and imagery-estimate controls show their current outcomes', async ({ mockApi: page }) => {
  await unavailableRegister(page);
  const dialog = page.locator('.ground-fallback-dialog');
  await dialog.locator('[data-option="url"]').click();
  await expect(dialog.locator('.ground-fallback-input')).toBeVisible();
  await dialog.getByRole('button', { name: 'Check and use this link' }).click();
  await expect(dialog.locator('.ground-fallback-result')).toHaveText('That is not a complete URL.');
  await dialog.locator('.ground-fallback-back').click();
  await expect(dialog.locator('.ground-fallback-options')).toBeVisible();
  await dialog.locator('[data-option="ocr"]').click();
  const estimates = page.getByRole('region', { name: 'Illustrative parcel estimates' });
  await expect(estimates).toBeVisible();
  await expect(estimates).toContainText('Estimated boundaries may be incomplete or wrong and do not establish legal boundaries.');
  await expect(estimates.getByRole('button', { name: 'Generate estimates' })).toBeVisible();
});

test('Not now dismisses register recovery without leaving a duplicate warning banner', async ({ mockApi: page }) => {
  const source = await unavailableRegister(page);
  const dialog = page.locator('.ground-fallback-dialog');
  await dialog.getByRole('button', { name: 'Not now', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('body')).not.toHaveClass(/ground-fallback-open/);
  await expect(page.locator('#parcel-source-status')).toHaveCount(0);
  await openLayerSection(page, 'parcels');
  const beforeRefresh = source.count();
  await page.locator('#refreshParcelDataButton').click();
  await expect.poll(source.count).toBeGreaterThan(beforeRefresh);
  await expect(dialog).toBeVisible();
  await expect(page.locator('#parcel-source-status')).toHaveCount(0);
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

test('Use the Schelling plan draws the plan layer and its panel over the map and installs no ground', async ({ mockApi: page }) => {
  await unavailableRegister(page);
  const dialog = page.locator('.ground-fallback-dialog');
  await dialog.locator('[data-option="schelling"]').click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).SchellingLayer.isEnabled())).toBe(true);
  await expect(page.locator('#schelling-panel')).toBeVisible();
  await expect.poll(() => page.locator('path.schelling-plan__block').count()).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as any).ParcelGroundFallback.activeSource())).toBeNull();
  expect(new URL(page.url()).searchParams.get('schelling')).toBe('120-12-16');
});

test('Explore banner requests its place, opens World view, and dismisses for this session', async ({ mockApi: page }) => {
  await stubBasemapTiles(page);
  const requests: any[] = [];
  await page.route('**/cities/requests', route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/?at=23.7104,90.4074,16&lang=en&reduceMotion=1', { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  const banner = page.locator('#explore-banner');
  await expect(banner).toBeVisible();
  await banner.locator('#explore-banner-ask').click();
  await expect(banner.locator('#explore-banner-ask')).toBeDisabled();
  await expect.poll(() => requests.length).toBe(1);
  // Explore requests preserve the exact map point (WorldCoverage.pointAt); the chip may
  // separately name the nearest city, so the payload uses the canonical rounded coordinate.
  expect(requests[0]).toMatchObject({ name: '23.71040, 90.40740', placeKey: 'point:23.71040,90.40740' });
  await banner.locator('#explore-banner-world').click();
  await expect(page.locator('#world-view')).toBeVisible({ timeout: 15_000 });
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


test('retry stays in one recovery dialog, spins, and shows the latest HTTP error', async ({ mockApi: page }) => {
 await unavailableRegister(page);
 const dialog=page.locator('.ground-fallback-dialog');
 await expect(page.locator('#parcel-source-status')).toHaveCount(0);
 await page.evaluate(() => {
  const w=window as any;
  w.fetchParcelData=async()=>new Promise((resolve,reject)=>{
   w.finishParcelRetry=()=>{
    const error=Object.assign(new Error('Service maintenance'),{status:503,upstreamStatus:503});
    w.ParcelGroundFallback.onGroundUnavailable({city:w.CityConfigManager.getCurrentCityId(),error,
     message:w.ParcelSourceHealth.describeFailure(error)});
    reject(error);
   };
  });
 });
 const retry=dialog.locator('[data-option="retry"]');
 await retry.click();
 await expect(retry).toHaveAttribute('aria-busy','true');
 await expect(retry).toHaveClass(/cb-busy/);
 await expect(retry).toBeDisabled();
 await expect(dialog).toHaveCount(1);
 await expect(dialog.locator('.ground-fallback-status')).toContainText('Retrying');
 await page.evaluate(()=>(window as any).finishParcelRetry());
 await expect(retry).not.toHaveAttribute('aria-busy','true');
 await expect(retry).toBeEnabled();
 await expect(dialog.locator('.ground-fallback-status')).toContainText('HTTP 503: Service maintenance');
 await expect(page.locator('#parcel-source-status')).toHaveCount(0);
});

test('Belgrade explains Serbia-only access and offers continuation without parcels',async({mockApi:page})=>{
 await page.route('https://portal.rgz.gov.rs/**',route=>route.fulfill({status:403,headers:{'Access-Control-Allow-Origin':'*'},body:'Forbidden'}));
 await page.route('**/parcel-provider-relay/rs-rgz-dkp-parcels',route=>route.fulfill({status:403,json:{error:'Forbidden'}}));
 await page.goto('/?city=belgrade&at=44.810918,20.438859,18&lang=en&reduceMotion=1',{waitUntil:'domcontentloaded'});
 const dialog=page.locator('.ground-fallback-dialog');
 await expect(dialog).toBeVisible({timeout:20000});
 await expect(dialog.locator('.ground-fallback-status')).toContainText('only accepts connections from Serbia');
 await expect(dialog.locator('.ground-fallback-status')).toContainText('HTTP 403');
 await expect(page.locator('#parcel-source-status')).toHaveCount(0);
 await dialog.locator('[data-option="without-parcels"]').click();
 await expect.poll(()=>page.evaluate(()=>(window as any).ParcelGroundFallback?.isWithoutParcels('belgrade'))).toBe(true);
 await expect(dialog).toHaveCount(0);
});
