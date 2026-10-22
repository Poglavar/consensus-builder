// Browser/node parity for canonical intent artifacts and the shared app formation host; no live API.
import { test, expect } from '../helpers/fixtures';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const turf = require('../../backend/node_modules/@turf/turf');
const builder = require('../../frontend/js/intent-design.js');
const cid = require('../../frontend/js/cid.js');
const root = path.resolve(__dirname, '../../frontend');
(globalThis as any).proj4 = require('../../backend/node_modules/proj4');
(globalThis as any).turf = turf;
const site = { type: 'Polygon', coordinates: [[[-0.1, 51.5], [-0.099, 51.5], [-0.099, 51.501], [-0.1, 51.501], [-0.1, 51.5]]] };
const files = [
  'vendor/proj4-2.22.0/proj4.js', 'vendor/turf-6.5.0/turf.min.js', 'vendor/noble-hashes-1.8.0/sha256.js',
  'js/cid.js', 'js/metric-frame.js', 'js/corridor-profile.js', 'js/corridor-osm-form.js', 'js/corridor-junction.js',
  'js/corridor-transition.js', 'js/proposals/corridor-levels.js', 'js/corridor-footprint.js', 'js/proposals/formation-depth.js',
  'js/design-record.js', 'js/parcel-layout-validation.js', 'js/parcel-layout-layouts.js', 'js/reparcellization-slice.js',
  'js/parcels/schelling-grid.js', 'js/intent-design.js', 'js/draft-link.js', 'js/approval-link.js'
];
test.beforeEach(async ({ page }) => {
  await page.setContent('<!doctype html><html><body><button data-agreement-action="mint">Mint</button></body></html>');
  for (const file of files) await page.addScriptTag({ path: path.join(root, file) });
});
for (const intent of [
  { kind: 'road', points: [[-0.1, 51.5], [-0.099, 51.5]], preset: '1+1 with cycle lanes' },
  { kind: 'space', spaceKind: 'park' }, { kind: 'building', floors: 5, coverage: 0.4 },
  { kind: 'parcel-layout', algorithm: 'schelling' }, { kind: 'urban-rule', rule: { floors: 6 } }
]) test(`MCP ${intent.kind} has identical canonical content and CID in node and browser`, async ({ page }) => {
  const input = { ...intent, site, city: 'london', title: 'A drawing', authoredAt: '2026-10-23T00:00:00.000Z' };
  const expected = builder.build(input, { turf });
  const actual = await page.evaluate(async input => {
    const w = window as any;
    const design = w.IntentDesign.build(input);
    const url = await w.DraftLink.build({ origin: 'https://app.example', design });
    return { design, cid: w.Cid.cidOfObject(design), decoded: (await w.DraftLink.parse(new URL(url).hash)).design };
  }, input);
  expect(actual.design).toEqual(expected);
  expect(actual.decoded).toEqual(expected);
  expect(actual.cid).toBe(cid.cidOfObject(expected));
});
test('an approval link focuses its action without clicking or invoking a wallet', async ({ page }) => {
  const result = await page.evaluate(() => {
    const w = window as any; let clicks = 0, signatures = 0;
    document.querySelector('button')!.addEventListener('click', () => { clicks++; });
    w.solanaWalletManager = { signTransaction() { signatures++; } };
    const intent = { action: 'mint', target: w.Cid.cidOfObject({ schema: 'agreement/v1' }), params: {} };
    const url = w.ApprovalLink.build({ origin: 'https://app.example', ...intent });
    w.ApprovalLink.preselect(document, w.ApprovalLink.parse(new URL(url)));
    return { clicks, signatures, selected: document.activeElement?.getAttribute('data-agreement-action') };
  });
  expect(result).toEqual({ clicks: 0, signatures: 0, selected: 'mint' });
});

for (const kind of ['space', 'parcel-layout', 'road']) test(`MCP ${kind} agreement ground matches the browser formation handlers`, async ({ page }) => {
  const scripts = [
    'js/agreement-record.js', 'js/agreement-ground.js', 'js/work-slicer.js', 'js/proposals/status.js',
    'js/proposals/parcel-contiguity.js', 'js/proposals/footprint-parts.js', 'js/proposals/parcel-arrangement.js',
    'js/proposals/plan-order.js', 'js/proposals/formation-edit.js', 'js/parcel-layout-record.js', 'js/parcel-layout-ownership.js',
    'js/parcels/live-fabric.js', 'js/proposals/apply/route.js', 'js/proposals/claims.js', 'js/proposals/lineage.js',
    'js/proposals/lifecycle-evidence.js', 'js/proposals/display-state.js', 'js/proposals/open-ground.js', 'js/proposals/apply/transaction.js',
    'js/proposal-parcel-identity.js', 'js/proposal-road-geometry.js', 'js/proposals/apply/finalize.js',
    'js/proposals/apply/road.js', 'js/proposals/apply/buildings.js', 'js/proposals/apply/structures.js',
    'js/proposals/apply/parcels.js', 'js/proposal-manager.js', 'js/agreement-headless.js'
  ];
  for (const file of scripts) await page.addScriptTag({ path: path.join(root, file) });
  const content = builder.build({ site, city: 'london', kind, spaceKind: 'park', algorithm: 'equal', count: 4,
    points: [[-0.1, 51.5005], [-0.099, 51.5005]], authoredAt: '2026-10-23T00:00:00.000Z' }, { turf });
  const fixture = { designs: [{ cid: cid.cidOfObject(content), content, parcelIds: ['A'] }],
    parcels: [{ type: 'Feature', id: 'A', properties: { parcelId: 'A' }, geometry: site }] };
  const nodeResult = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    "import{readFileSync}from'node:fs';import{deriveAgreementGround}from'./agents/mcp-ground.js';console.log(JSON.stringify(await deriveAgreementGround(JSON.parse(readFileSync(0,'utf8')))));"],
    { cwd: path.resolve(root, '../backend'), input: JSON.stringify(fixture), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
  const browserResult = await page.evaluate(fixture => (window as any).AgreementHeadless.derive(fixture), fixture);
  expect(browserResult).toEqual(nodeResult);
});
