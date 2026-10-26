// A real app route imports and applies an unpublished MCP object reference without pinning or indexing it.
import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { stubBasemapTiles, PARCEL_GEOMETRY, PARCEL_ID } from '../helpers/runtime';
import { pageIndex } from '../helpers/mocks/shared-server';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const builder = require('../../frontend/js/intent-design.js');
import { privatePreview } from '../helpers/private-preview';
const turf = require('../../backend/node_modules/@turf/turf');
const cid = require('../../frontend/js/cid.js');
const agreementRecord = require('../../frontend/js/agreement-record.js');
const agreementGround = require('../../frontend/js/agreement-ground.js');
const planRecord = require('../../frontend/js/plan-record.js');

test('MCP draft reference opens an applied local park with no publication @core', async ({ mockApi: page, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  await stubBasemapTiles(page);
  const design = builder.build({ kind: 'space', spaceKind: 'park', site: PARCEL_GEOMETRY, city: 'zagreb', title: 'MCP preview park', authoredAt: '2026-10-23T00:00:00.000Z' }, { turf });
  const edited = builder.modify(design, [{ type: 'set_tree_count', count: 25 }], { turf });
  const url = await privatePreview(page, baseURL!, { design: edited });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  await expect.poll(() => page.evaluate(() => {
    const w = window as any;
    const records = w.proposalStorage?.getAllProposals?.() || [];
    const record = records.find((r: any) => r.title === 'MCP preview park');
    return record ? { published: !!record.published, lifecycle: record.lifecycleStatus, cid: w.DesignRecord.cidOf(record), pieces: w.LiveParcelFabric.producedBy(record.proposalId).length } : null;
  }), { timeout: 60_000 }).toEqual({ published: false, lifecycle: 'draft', cid: cid.cidOfObject(edited), pieces: 1 });
  await expect(page.getByRole('heading', { name: 'MCP preview park', exact: true })).toBeVisible();
  await expect(page.locator('.park-tree-glyph')).toHaveCount(25);
  await page.screenshot({ path: testInfo.outputPath('draft-preview.png') });
  expect(pageIndex(page).requests.filter(r => r.method === 'POST' && ['/pins', '/designs', '/plans', '/agreements'].includes(r.path))).toEqual([]);
});

test('MCP granular height and rotation edits reach the live building renderer @core', async ({ mockApi: page, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  await stubBasemapTiles(page);
  const design = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    "import{readFileSync}from'node:fs';import{intentDesign,appTurf as turf}from'./agents/mcp-geometry.js';import{editedDesign}from'./agents/mcp-edit.js';import{cidOfObject}from'./cid.js';const d=intentDesign.build(JSON.parse(readFileSync(0,'utf8')),{turf});console.log(JSON.stringify(editedDesign(d,cidOfObject(d),[{op:'replace',path:'/geometry/buildings/0/properties/height',value:18},{op:'transform',path:'/geometry/buildings/0/geometry',degrees:-15}])));"],
    { cwd: path.resolve(__dirname, '../../backend'), encoding: 'utf8', input: JSON.stringify({ kind: 'building', site: PARCEL_GEOMETRY, city: 'zg', title: 'Edited tower', floors: 12, coverage: 0.2 }), stdio: ['pipe', 'pipe', 'pipe'] }));
  await page.goto(await privatePreview(page, baseURL!, { design }), { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  await expect.poll(() => page.evaluate(() => {
    const w = window as any;
    const record = w.proposalStorage?.getAllProposals?.().find((r: any) => r.title === 'Edited tower');
    const drawing = w.proposedBuildings?.find((b: any) => b.properties.proposalId === record?.proposalId);
    return record && drawing ? { published: !!record.published, cid: w.DesignRecord.cidOf(record), height: drawing.properties.height, floors: drawing.properties.floors, geometry: drawing.geometry } : null;
  }), { timeout: 60_000 }).toEqual({ published: false, cid: cid.cidOfObject(design), height: 18, floors: 6, geometry: design.geometry.buildings[0].geometry });
  await page.screenshot({ path: testInfo.outputPath('edited-tower.png') });
  expect(pageIndex(page).requests.some(r => r.method === 'POST' && ['/pins', '/designs', '/plans', '/agreements'].includes(r.path))).toBe(false);
});

test('MCP agreement reference imports matching ground as an unpublished local agreement @core', async ({ mockApi: page, baseURL }) => {
  test.setTimeout(120_000);
  await stubBasemapTiles(page);
  const design = builder.build({ kind: 'space', spaceKind: 'park', site: PARCEL_GEOMETRY, city: 'zagreb', title: 'Agreement park', authoredAt: '2026-10-23T00:00:00.000Z' }, { turf });
  const designCid = cid.cidOfObject(design), areaM2 = agreementGround.areaOf(PARCEL_GEOMETRY);
  const planContent = planRecord.create('MCP preview agreement', [designCid], { at: '45.80025,15.9817,18', mode: '2d', city: 'zagreb', language: 'en' });
  const plan = { cid: cid.cidOfObject(planContent), content: planContent };
  const local = { schema: 'agreement/v1', id: 'fixture-agreement', title: 'MCP preview agreement', author: 'Preview author', sponsor: '11111111111111111111111111111111', city: 'zagreb', createdAt: design.authoredAt,
    plan,
    designs: [{ proposalId: designCid, cid: designCid, goal: design.goal, title: design.title }],
    inputs: { parcels: [{ parcelId: PARCEL_ID, parcelSourceId: 'oss-wfs', areaM2, holders: [] }], openGroundM2: 0 },
    outputs: [{ hash: agreementRecord.outputHash(PARCEL_GEOMETRY), pieceId: 'fixture-piece', areaM2, fromParcelIds: [PARCEL_ID], producedBy: designCid, role: 'parcel', holders: [], geometry: PARCEL_GEOMETRY }],
    allocations: [], money: { currency: 'EUR', lines: [] }, rule: { electorate: 'community', binding: false, approvalConfig: null, lens: [] }, deadline: null };
  const agreement = agreementRecord.published(local, (id: string) => id);
  const url = await privatePreview(page, baseURL!, { agreement, plan, designs: [design] });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  await expect(page.locator('#agreement-panel')).toContainText('MCP preview agreement', { timeout: 60_000 });
  const actual = await page.evaluate(() => {
    const w = window as any;
    const agreement = w.AgreementStore.list().find((record: any) => record.title === 'MCP preview agreement');
    return agreement ? { published: !!agreement.published, hashes: agreement.outputs.map((output: any) => output.hash), cid: w.AgreementRecord.publishedCid(agreement, (id: string) => w.DesignRecord.cidOf(w.proposalStorage.getProposal(id))) } : null;
  });
  expect(actual).toEqual({ published: false, hashes: agreement.outputs.map((output: any) => output.hash), cid: cid.cidOfObject(agreement) });
  expect(pageIndex(page).requests.some(r => r.method === 'POST' && ['/pins', '/designs', '/plans', '/agreements'].includes(r.path))).toBe(false);
});
