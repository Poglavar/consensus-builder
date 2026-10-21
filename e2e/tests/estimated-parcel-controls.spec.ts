// Exercise estimated-layer controls through the real application UI and worker.
import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { selectNativeOption } from '../helpers/controls';
import type { Page } from '@playwright/test';

const DGU_WFS = 'https://oss.uredjenazemlja.hr/OssWebServices/wfs**';
const contextFixture = { type: 'FeatureCollection', features: [
  { type: 'Feature', id: 'w100', geometry: { type: 'Polygon', coordinates: [[[15.98206, 45.80011], [15.98234, 45.80011], [15.98234, 45.80039], [15.98206, 45.80039], [15.98206, 45.80011]]] }, properties: { kind: 'building', source_id: 'w100' } },
  { type: 'Feature', id: 'w200', geometry: { type: 'LineString', coordinates: [[15.9812, 45.7998], [15.9832, 45.7998]] }, properties: { kind: 'road', source_id: 'w200', highway: 'residential', width_m: 4, bridge: false, tunnel: false } },
  { type: 'Feature', id: 'w300', geometry: { type: 'Polygon', coordinates: [[[15.9828, 45.80085], [15.9830, 45.80085], [15.9830, 45.80105], [15.9828, 45.80105], [15.9828, 45.80085]]]}, properties: { kind: 'water', source_id: 'w300' } },
] };

async function unavailableRegister(page: Page): Promise<void> {
  await page.route(DGU_WFS, route => route.fulfill({ status: 503, body: 'fixture: unavailable' }));
  await page.route('**/parcels**', route => {
    const request = route.request();
    if (!['fetch', 'xhr'].includes(request.resourceType()) || request.method() !== 'GET') return route.fallback();
    if (new URL(request.url()).hostname === 'register.example.test') return route.fallback();
    return route.fulfill({ status: 503, json: { error: 'Fixture register unavailable', retryAfterSeconds: 0 } });
  });
  await page.goto('/?city=zg&at=45.80025,15.9822,18&lang=en&reduceMotion=1', { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  await expect(page.locator('.ground-fallback-dialog')).toBeVisible();
}

async function clickVisibleEstimate(page: Page): Promise<string> {
  const target = await page.evaluate(() => {
    const w = window as any;
    const id = w.LiveParcelFabric.snapshot().parcelIds.find((parcelId: string) => parcelId.startsWith('EST:'));
    if (!id) throw new Error('No estimated parcel is loaded in the live fabric');
    const layer = w.ParcelPresenter.getLayer(id);
    if (!layer) throw new Error(`No presented Leaflet layer for ${id}`);
    const center = layer.getBounds().getCenter();
    w.map.panTo(center, { animate: false });
    return { id, lat: center.lat, lng: center.lng };
  });
  const point = await page.evaluate(({ lat, lng }) => {
    const w = window as any;
    const p = w.map.latLngToContainerPoint([lat, lng]);
    const box = w.map.getContainer().getBoundingClientRect();
    return { x: box.left + p.x, y: box.top + p.y };
  }, target);
  await page.mouse.click(point.x, point.y);
  return target.id;
}

test('estimated parcel controls collapse, tune, generate, cancel, export, remove by parcel click, and close', async ({ mockApi: page }) => {
  test.setTimeout(60_000);
  let contextCalls = 0;
  let releaseInitial!: () => void;
  const initialHeld = new Promise<void>(resolve => { releaseInitial = resolve; });

  try {
    // Only the context and satellite image network boundaries are fixtures; area preparation,
    // image rasterization, the worker, persistence, source installation and click handlers are real.
    await page.route('**/parcel-estimate/context**', async route => {
      contextCalls++;
      if (contextCalls === 1) {
        await initialHeld;
      }
      await route.fulfill({ status: 200, contentType: 'application/geo+json', body: JSON.stringify(contextFixture) }).catch(() => {});
    });
    await unavailableRegister(page);
    const tilePng = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
      const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#b9aa87'; ctx.fillRect(0, 0, 256, 256);
      ctx.fillStyle = '#706958';
      for (let y = 24; y < 240; y += 48) for (let x = 18; x < 240; x += 52) ctx.fillRect(x, y, 24, 18);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    await page.route('**/tiles/satellite-v2/**/*.jpg**', route => route.fulfill({ status: 200,
      contentType: 'image/png', body: Buffer.from(tilePng, 'base64') }));

    await page.locator('.ground-fallback-option[data-option="ocr"]').click();
    const panel = page.locator('.parcel-estimate-panel');
    await expect(panel).toBeVisible();
    await expect.poll(() => contextCalls).toBe(1);
    const cancel = panel.getByRole('button', { name: 'Cancel', exact: true });
    await expect(cancel).toBeVisible();
    await cancel.click();
    await expect(panel.locator('.parcel-estimate-status')).toContainText('Cancelled');
    releaseInitial();
    await expect(cancel).toBeHidden();

    const collapse = panel.getByRole('button', { name: 'Collapse controls' });
    await collapse.click();
    await expect(panel).toHaveClass(/is-collapsed/);
    const expand = panel.getByRole('button', { name: 'Show parcel controls' });
    await expect(expand).toHaveAttribute('aria-expanded', 'false');
    await expand.click();
    await expect(collapse).toHaveAttribute('aria-expanded', 'true');
    await expect(panel).not.toHaveClass(/is-collapsed/);

    const size = panel.locator('#parcel-estimate-size');
    const generate = panel.getByRole('button', { name: 'Generate estimates', exact: true });
    await selectNativeOption(size, '256');
    await expect(size).toHaveValue('256');
    await expect(generate).toBeEnabled();
    await selectNativeOption(size, 'viewport');
    await expect(size).toHaveValue('viewport');

    const sensitivity = panel.locator('#parcel-estimate-sensitivity');
    await sensitivity.focus(); await page.keyboard.press('ArrowRight');
    await expect(sensitivity).toHaveValue('56');
    const rectangularity = panel.locator('#parcel-estimate-rectangularity');
    await rectangularity.focus(); await page.keyboard.press('ArrowRight');
    await expect(rectangularity).toHaveValue('66');

    const reload = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
    await generate.click();
    await reload;
    await waitForMapReady(page);
    await expect(panel).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).LiveParcelFabric?.snapshot().featureCount || 0)).toBeGreaterThan(0);
    expect(contextCalls).toBe(2);
    const download = async () => {
      const pending = page.waitForEvent('download');
      await panel.getByRole('button', { name: 'Export GeoJSON', exact: true }).click();
      const file = await pending;
      const stream = await file.createReadStream();
      let contents = '';
      for await (const chunk of stream!) contents += chunk.toString();
      return JSON.parse(contents);
    };
    const exported = await download();
    expect(exported.features.length).toBeGreaterThan(0);
    expect(exported.features.every((feature: any) => feature.properties.estimated === true && /^EST:/.test(feature.id))).toBe(true);
    expect(exported.demo.settings).toMatchObject({ sensitivity: 56, rectangularity: 66 });

    await panel.getByRole('button', { name: 'Remove a plot', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Remove a plot', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const generatedIds = exported.features.map((feature: any) => feature.id).sort();
    const removalReload = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
    const removedId = await clickVisibleEstimate(page);
    await removalReload;
    await waitForMapReady(page);
    await expect(panel).toBeVisible();
    expect(generatedIds).toContain(removedId);
    await expect.poll(async () => {
      const liveIds = await page.evaluate(() => (window as any).LiveParcelFabric.snapshot().parcelIds as string[]);
      return liveIds.includes(removedId);
    }).toBe(false);
    const afterRemoval = await download();
    expect(afterRemoval.features.every((feature: any) => feature.properties.estimated === true && /^EST:/.test(feature.id))).toBe(true);
    const remainingIds = afterRemoval.features.map((feature: any) => feature.id).sort();
    expect(remainingIds).toEqual(generatedIds.filter((id: string) => id !== removedId));
    expect(afterRemoval.demo.removed_plot_ids).toContain(removedId);

    await panel.getByRole('button', { name: 'Close estimates', exact: true }).click();
    await expect(panel).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).ParcelGroundFallback.activeSource()?.kind)).toBe('estimated-local');
    const liveIdsAfterClose = await page.evaluate(() => (window as any).LiveParcelFabric.snapshot().parcelIds as string[]);
    expect(liveIdsAfterClose).not.toContain(removedId);
  } finally {
    releaseInitial();
  }
});
