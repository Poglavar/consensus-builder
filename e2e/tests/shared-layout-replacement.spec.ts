import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { stubBasemapTiles, PARCEL_GEOMETRY } from '../helpers/runtime';
import { sampleParcels } from '../helpers/mocks/parcel-data';
import { fileDesign, pageIndex } from '../helpers/mocks/shared-server';
const records = require('../../frontend/js/design-record.js');

for (const width of [390, 1280]) test(`replacing shared layout releases old streets and ground at ${width}px @core`, async ({ mockApi: page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width, height: 844 });
  await stubBasemapTiles(page);
  const index = pageIndex(page), ring = PARCEL_GEOMETRY.coordinates[0];
  const west = Math.min(...ring.map(p => p[0])), east = Math.max(...ring.map(p => p[0]));
  const south = Math.min(...ring.map(p => p[1])), north = Math.max(...ring.map(p => p[1]));
  const box = (w: number, s: number, e: number, n: number) => ({ type: 'Polygon', coordinates: [[[w,s],[e,s],[e,n],[w,n],[w,s]]] });
  const mid = (west + east) / 2, halfWidth = (east - west) * 0.05;
  const left = box(west, south, mid, north), right = box(mid, south, east, north);
  const put = (record: any) => fileDesign(index, records.published({ city: 'zg', ...record }));
  const layout = (title: string, plots: any[], createdAt: string) => put({ title, goal: 'parcel-layout', createdAt,
    site: PARCEL_GEOMETRY, parcelLayout: { pool: PARCEL_GEOMETRY, poolSource: 'site',
      plots: plots.map(geometry => ({ geometry, source: 'manual' })) } });
  const oldLayout = layout('Old parcel layout', [PARCEL_GEOMETRY], '2026-10-23T10:00:00Z');
  const ribbon = box(mid - halfWidth, south, mid + halfWidth, north);
  const oldRoad = put({ title: 'Old street', goal: 'road-track', createdAt: '2026-10-23T11:00:00Z', site: ribbon,
    roadProposal: { definition: { polygon: ribbon } } });
  const outside = put({ title: 'Unrelated park', goal: 'park', createdAt: '2026-10-23T12:00:00Z',
    site: sampleParcels.features[1].geometry,
    structureProposal: { kind: 'park', geometry: sampleParcels.features[1].geometry } });
  const newLayout = layout('New parcel layout', [left, right], '2026-10-24T10:00:00Z');
  const newPark = put({ title: 'New park', goal: 'park', createdAt: '2026-10-24T11:00:00Z', site: left,
    structureProposal: { kind: 'park', geometry: left } });
  const url = (cids: string[]) => `/designs/${cids.join(',')}?city=zg&lang=en&reduceMotion=1`;
  const applied = () => page.evaluate(() => {
    const w = window as any;
    return w.proposalStorage.getAllProposals().filter((p: any) => w.isApplied(p)).map((p: any) => w.DesignSync.publishedCid(p)).sort();
  });
  const original = [oldLayout, oldRoad, outside].sort(), replacement = [newLayout, newPark, outside].sort();
  await page.goto(url(original), { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  await expect.poll(applied, { timeout: 60_000 }).toEqual(original);
  await page.goto(url([newLayout, newPark]), { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  const warning = page.getByRole('alertdialog', { name: 'Plan conflicts' });
  await expect(warning).toBeVisible({ timeout: 60_000 });
  await expect(warning).toContainText('Old street');
  await expect(warning).toContainText('Old parcel layout');
  await expect(warning).not.toContainText('Unrelated park');
  await warning.getByRole('button', { name: 'Unapply existing & continue', exact: true }).click();
  await expect.poll(applied, { timeout: 60_000 }).toEqual(replacement);
  await expect(page.locator('.shared-plan-failures')).toHaveCount(0);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await waitForMapReady(page);
  await expect.poll(applied, { timeout: 60_000 }).toEqual(replacement);
  await expect(page.getByRole('alertdialog', { name: 'Plan conflicts' })).toHaveCount(0);
  const saved = await page.evaluate(() => (window as any).proposalStorage.getAllProposals().length);
  expect(saved).toBe(5);
  expect(index.requests.some(r => r.method === 'POST' && ['/pins', '/designs', '/agreements'].includes(r.path))).toBe(false);
});
