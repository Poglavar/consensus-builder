// A real app route imports and applies an unpublished MCP fragment without pinning or indexing it.
import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { stubBasemapTiles, PARCEL_GEOMETRY, PARCEL_ID } from '../helpers/runtime';
import { pageIndex } from '../helpers/mocks/shared-server';
const builder = require('../../frontend/js/intent-design.js');
const links = require('../../frontend/js/draft-link.js');
const turf = require('../../backend/node_modules/@turf/turf');
const cid = require('../../frontend/js/cid.js');
const agreementRecord = require('../../frontend/js/agreement-record.js');

test('MCP draft fragment opens an applied local park with no publication @core', async ({ mockApi: page, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  await stubBasemapTiles(page);
  const design = builder.build({ kind: 'space', spaceKind: 'park', site: PARCEL_GEOMETRY, city: 'zagreb', title: 'MCP preview park', authoredAt: '2026-10-23T00:00:00.000Z' }, { turf });
  const url = await links.build({ origin: baseURL, design });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  await expect.poll(() => page.evaluate(() => {
    const w = window as any;
    const records = w.proposalStorage?.getAllProposals?.() || [];
    const record = records.find((r: any) => r.title === 'MCP preview park');
    return record ? { published: !!record.published, lifecycle: record.lifecycleStatus, cid: w.DesignRecord.cidOf(record), pieces: w.LiveParcelFabric.producedBy(record.proposalId).length } : null;
  }), { timeout: 60_000 }).toEqual({ published: false, lifecycle: 'draft', cid: cid.cidOfObject(design), pieces: 1 });
  await expect(page.getByText('MCP preview park', { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('draft-preview.png') });
  expect(pageIndex(page).requests.filter(r => r.method === 'POST' && ['/pins', '/designs', '/agreements'].includes(r.path))).toEqual([]);
});

test('MCP agreement fragment imports matching ground as an unpublished local agreement @core', async ({ mockApi: page, baseURL }) => {
  test.setTimeout(120_000);
  await stubBasemapTiles(page);
  const design = builder.build({ kind: 'space', spaceKind: 'park', site: PARCEL_GEOMETRY, city: 'zagreb', title: 'Agreement park', authoredAt: '2026-10-23T00:00:00.000Z' }, { turf });
  const designCid = cid.cidOfObject(design), areaM2 = turf.area(turf.feature(PARCEL_GEOMETRY));
  const local = { schema: 'agreement/v1', id: 'fixture-agreement', title: 'MCP preview agreement', city: 'zagreb', createdAt: design.authoredAt,
    designs: [{ proposalId: designCid, cid: designCid, goal: design.goal, title: design.title }],
    inputs: { parcels: [{ parcelId: PARCEL_ID, areaM2, holders: [] }], openGroundM2: 0 },
    outputs: [{ hash: agreementRecord.outputHash(PARCEL_GEOMETRY), pieceId: 'fixture-piece', areaM2, fromParcelIds: [PARCEL_ID], producedBy: designCid, role: 'parcel', holders: [], geometry: PARCEL_GEOMETRY }],
    allocations: [], money: { currency: 'EUR', lines: [] }, rule: { electorate: 'community', binding: false, approvalConfig: null, lens: [] }, deadline: null };
  const agreement = agreementRecord.published(local, (id: string) => id);
  const url = await links.build({ origin: baseURL, agreement, designs: [design] });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  await expect(page.locator('#agreement-panel')).toContainText('MCP preview agreement', { timeout: 60_000 });
  const actual = await page.evaluate(() => {
    const w = window as any;
    const agreement = w.AgreementStore.list().find((record: any) => record.title === 'MCP preview agreement');
    return agreement ? { published: !!agreement.published, hashes: agreement.outputs.map((output: any) => output.hash) } : null;
  });
  expect(actual).toEqual({ published: false, hashes: agreement.outputs.map((output: any) => output.hash) });
  expect(pageIndex(page).requests.some(r => r.method === 'POST' && ['/pins', '/designs', '/agreements'].includes(r.path))).toBe(false);
});
