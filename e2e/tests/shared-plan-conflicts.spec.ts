// A device that opened the old plan resolves revisions before anything is unapplied.
import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { stubBasemapTiles, PARCEL_GEOMETRY } from '../helpers/runtime';
import { sampleParcels } from '../helpers/mocks/parcel-data';
import { cidOfObject, fileDesign, pageIndex } from '../helpers/mocks/shared-server';
const records = require('../../frontend/js/design-record.js');

for (const width of [390, 1280]) test(`shared plan conflicts offer unapply, skip and cancel at ${width}px @core`, async ({ mockApi: page }, testInfo) => {
  test.setTimeout(240_000);
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
    let unrelatedParkSnapshot: { originalGoal: string; proposalId: string; serialized: string } | null = null;
    if (answer === 'Unapply existing & continue') {
      unrelatedParkSnapshot = await page.evaluate(cid => {
        const w = window as any;
        const record = w.DesignSync.localCopyOf(cid);
        if (!record) throw new Error('The unrelated park must have a local published record.');
        const originalGoal = record.goal;
        record.goal = 'unsupported-retired-layout';
        return { originalGoal, proposalId: String(record.proposalId), serialized: JSON.stringify(structuredClone(record)) };
      }, parkCid);
    }
    await warning.getByRole('button', { name: answer, exact: true }).click();
    await expect(warning).toHaveCount(0);
    if (unrelatedParkSnapshot) {
      // Mutating this fixture's goal invalidates its published CID, but it must stay applied.
      await expect.poll(applied, { timeout: 60_000 }).toEqual([...newCids, null].sort());
      const afterReplacement = await page.evaluate(id => {
        const record = (window as any).proposalStorage.getProposal(id);
        return record ? JSON.stringify(structuredClone(record)) : null;
      }, unrelatedParkSnapshot.proposalId);
      expect(afterReplacement).toBe(unrelatedParkSnapshot.serialized);
      expect(JSON.parse(afterReplacement!)).toMatchObject({ goal: 'unsupported-retired-layout', applied: true });
      await page.evaluate(({ id, goal }) => {
        const w = window as any;
        const record = w.proposalStorage.getProposal(id);
        if (!record) throw new Error('The unrelated park local record disappeared after replacement.');
        record.goal = goal;
        w.proposalStorage.save();
      }, { id: unrelatedParkSnapshot.proposalId, goal: unrelatedParkSnapshot.originalGoal });
    }
    await expect.poll(applied, { timeout: 60_000 }).toEqual(answer === 'Unapply existing & continue' ? revised : original);
    await expect(page.locator('.shared-plan-failures')).toHaveCount(0);
  }
  await expect.poll(() => page.evaluate(() => (window as any).proposedBuildings.map((b: any) => b.properties.floors).sort((a: number,b: number) => a-b))).toEqual([18,22,27,32]);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await waitForMapReady(page);
  await expect.poll(applied).toEqual(revised);
  await expect(page.getByRole('alertdialog', { name: 'Plan conflicts' })).toHaveCount(0);
  const saved = await page.evaluate(() => {
    const w = window as any;
    return w.proposalStorage.getAllProposals().map((p: any) => ({ cid: w.DesignRecord.cidOf(p), published: w.DesignSync.publishedCid(p) }));
  });
  expect(saved).toHaveLength(9);
  saved.forEach(record => expect(record.cid).toBe(record.published));

  // Private imports must queue behind an older map snapshot. Otherwise that snapshot erases the
  // newly imported draft before the person confirms replacement, producing a missing-member error.
  const privateDesign = structuredClone(index.designs.get(newCids[0])!.content);
  privateDesign.title = 'Private tower revision';
  privateDesign.origin = { cid: newCids[0] };
  const privateDraftToken = 'a'.repeat(32);
  const privateDraftReference = new URL(`/mcp/previews/${privateDraftToken}`, page.url()).href;
  await page.route(privateDraftReference, route => route.fulfill({ json: {
    cid: cidOfObject(privateDesign), record: privateDesign, parcelSourceId: null
  } }));
  const draftId = await page.evaluate(async ({ content, reference }) => {
    const w = window as any, manager = w.ProposalManager;
    const url = `/designs?draft=${encodeURIComponent(reference)}`;
    history.replaceState({}, '', url);
    const run = manager.runParcelMutation.bind(manager);
    let started: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { w.__releaseSharedImport = resolve; });
    w.__sharedBackground = run('test-background-map-update', null, async () => {
      started(); await gate; return true;
    }, { _mapMutation: false });
    await begun;
    manager.runParcelMutation = (kind: string, ...args: any[]) => {
      if (kind === 'import-shared-designs') w.__sharedImportQueued = true;
      return run(kind, ...args);
    };
    w.__privatePreview = w.DraftPreview.open().then((result: any) => {
      w.__privatePreviewResult = { failed: result.failed, applied: result.applied };
    }).catch((error: Error) => { w.__privatePreviewError = error.message; });
    return `draft-${w.Cid.cidOfObject(content)}`;
  }, { content: privateDesign, reference: privateDraftReference });
  await expect.poll(() => page.evaluate(() => (window as any).__sharedImportQueued)).toBe(true);
  expect(await page.evaluate(id => !!(window as any).proposalStorage.getProposal(id), draftId)).toBe(false);
  await page.evaluate(async () => { const w = window as any; w.__releaseSharedImport(); await w.__sharedBackground; });
  const privateWarning = page.getByRole('alertdialog', { name: 'Plan conflicts' });
  await expect(privateWarning).toBeVisible();
  await privateWarning.getByRole('button', { name: 'Unapply existing & continue', exact: true }).click();
  await expect.poll(() => page.evaluate(id => !!(window as any).proposalStorage.getProposal(id)?.applied, draftId)).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).__privatePreviewResult)).toEqual({ failed: [], applied: [draftId] });
  expect(await page.evaluate(() => (window as any).__privatePreviewError)).toBeUndefined();
  await expect(page.locator('.shared-plan-failures')).toHaveCount(0);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await waitForMapReady(page);
  await expect.poll(() => page.evaluate(id => !!(window as any).proposalStorage.getProposal(id)?.applied, draftId)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`revised-plan-${width}.png`) });
  expect(index.requests.some(r => r.method === 'POST' && ['/pins','/designs','/agreements'].includes(r.path))).toBe(false);
});
