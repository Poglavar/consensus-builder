// A device that opened the old plan resolves revisions before anything is unapplied.
import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { stubBasemapTiles, PARCEL_GEOMETRY } from '../helpers/runtime';
import { sampleParcels } from '../helpers/mocks/parcel-data';
import { fileDesign, pageIndex } from '../helpers/mocks/shared-server';
const records = require('../../frontend/js/design-record.js');

for (const width of [390, 1280]) test(`shared plan conflicts offer unapply, skip and cancel at ${width}px @core`, async ({ mockApi: page }, testInfo) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width, height: 844 });
  await stubBasemapTiles(page);
  const index = pageIndex(page), ring = PARCEL_GEOMETRY.coordinates[0];
  const west = Math.min(...ring.map(p => p[0])), east = Math.max(...ring.map(p => p[0]));
  const south = Math.min(...ring.map(p => p[1])), north = Math.max(...ring.map(p => p[1]));
  const oldCids: string[] = [], newCids: string[] = [];
  for (let i = 0; i < 4; i++) {
    const x = west + (east - west) * (0.1 + (i % 2) * 0.5);
    const y = south + (north - south) * (0.1 + Math.floor(i / 2) * 0.5);
    const dx = (east - west) * 0.25, dy = (north - south) * 0.25;
    const footprint = { type: 'Polygon', coordinates: [[[x,y],[x+dx,y],[x+dx,y+dy],[x,y+dy],[x,y]]] };
    const make = (floors: number, origin: any = null) => records.published({ goal: 'single', city: 'zg', title: `Tower ${i+1}`,
      site: footprint, geometry: { buildings: [{ type: 'Feature', properties: { floors, height: floors*3, type: 'proposedBuilding' }, geometry: footprint }] },
      buildingProposal: { typologyType: 'single', parameters: { floors, height: floors*3 } }, origin, createdAt: '2026-10-24T00:00:00.000Z' });
    const old = fileDesign(index, make(12+i)); oldCids.push(old);
    newCids.push(fileDesign(index, make([18,22,27,32][i], { cid: old })));
  }
  const parkCid = fileDesign(index, records.published({ goal: 'park', city: 'zg', title: 'Unrelated saved park',
    site: sampleParcels.features[1].geometry, structureProposal: { kind: 'park', geometry: sampleParcels.features[1].geometry },
    createdAt: '2026-10-24T00:00:00.000Z' }));
  const url = (cids: string[]) => `/designs/${cids.join(',')}?city=zg&lang=en&reduceMotion=1`;
  const applied = () => page.evaluate(() => {
    const w = window as any;
    return w.proposalStorage.getAllProposals().filter((p: any) => w.isApplied(p)).map((p: any) => w.DesignSync.publishedCid(p)).sort();
  });
  const original = [...oldCids, parkCid].sort(), revised = [...newCids, parkCid].sort();
  await page.goto(url([...oldCids,parkCid]), { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  await expect.poll(applied, { timeout: 60_000 }).toEqual(original);

  for (const answer of ['Cancel', 'Skip conflicting designs', 'Unapply existing & continue']) {
    await page.goto(url(newCids), { waitUntil: 'domcontentloaded' });
    await waitForMapReady(page);
    const warning = page.getByRole('alertdialog', { name: 'Plan conflicts' });
    await expect(warning).toBeVisible({ timeout: 60_000 });
    await expect.poll(applied).toEqual(original);
    for (let i = 1; i <= 4; i++) await expect(warning).toContainText(`Tower ${i}`);
    await expect(warning).not.toContainText('Unrelated saved park');
    await warning.getByRole('button', { name: answer, exact: true }).click();
    await expect(warning).toHaveCount(0);
    await expect.poll(applied, { timeout: 60_000 }).toEqual(answer === 'Unapply existing & continue' ? revised : original);
    await expect(page.locator('.shared-plan-failures')).toHaveCount(0);
  }
  await expect.poll(() => page.evaluate(() => (window as any).proposedBuildings.map((b: any) => b.properties.floors).sort((a: number,b: number) => a-b))).toEqual([18,22,27,32]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  await expect.poll(applied).toEqual(revised);
  await expect(page.getByRole('alertdialog', { name: 'Plan conflicts' })).toHaveCount(0);
  const saved = await page.evaluate(() => {
    const w = window as any;
    return w.proposalStorage.getAllProposals().map((p: any) => ({ cid: w.DesignRecord.cidOf(p), published: w.DesignSync.publishedCid(p) }));
  });
  expect(saved).toHaveLength(9);
  saved.forEach(record => expect(record.cid).toBe(record.published));
  await page.screenshot({ path: testInfo.outputPath(`revised-plan-${width}.png`) });
  expect(index.requests.some(r => r.method === 'POST' && ['/pins','/designs','/agreements'].includes(r.path))).toBe(false);
});
