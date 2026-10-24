// A design link (/designs/<cid>) matches local copies by content address only: a local record whose
// key equals the CID, or a fork naming it as its origin, is not the published design; the link
// imports it as design-<cid> once and then reuses that exact copy (plan-design-agreement.md M2).
import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { createSpace, openCity, showProposal, stubBasemapTiles, PARCEL_ID } from '../helpers/runtime';
import { mockAllApiRoutes } from '../helpers/mocks/api-routes';
import { attachSharedIndex, fileDesign, pageIndex } from '../helpers/mocks/shared-server';
import { mockBuildingScene } from '../helpers/mocks/building-data';
import { sampleParcels } from '../helpers/mocks/parcel-data';

test('a shared 3D camera retains both designs, existing buildings and the selected section', async ({ mockApi: page }) => {
  const records = require('../../frontend/js/design-record.js');
  const index = pageIndex(page);
  const cids = sampleParcels.features.slice(0, 2).map((parcel, i) => fileDesign(index, records.published({
    title: `Shared garden ${i + 1}`, goal: 'park', city: 'zg', site: parcel.geometry,
    structureProposal: { kind: 'park', geometry: parcel.geometry }, createdAt: '2026-10-24T00:00:00.000Z'
  })));
  await stubBasemapTiles(page);
  await mockBuildingScene(page);
  const id = `design-${cids[0]}`;
  const query = new URLSearchParams({ city: 'zg', lang: 'en', model: '', reduceMotion: '1',
    existing: 'solid', permitted: 'off', proposed: 'solid', existingScope: 'all',
    camera: '45.80025,15.9822,20,-0.65,140', at: '45.80025,15.9822,18',
    planningSelection: `proposed:${id}` });
  await page.goto(`/designs/${cids.join(',')}?${query}`, { waitUntil: 'domcontentloaded' });
  const row = page.locator('#three-click-stack .click-stack__section[data-kind="designs"] .click-stack__row');
  await expect(row).toHaveAttribute('aria-expanded', 'true', { timeout: 30_000 });
  const sceneCounts = () => page.evaluate(() => {
    const scene = (window as any).getThreeModeInternals().scene;
    let buildings = 0, parks = 0;
    scene.traverseVisible((object: any) => {
      if (object.userData.isNearbyBuilding3D) buildings++;
      if (object.userData.isParkGround) parks++;
    });
    return { buildings, parks };
  });
  await expect.poll(sceneCounts).toEqual({ buildings: 2, parks: 2 });
  await expect(page.locator('.three-mode-isolation-banner')).toBeHidden();
  const view = await page.evaluate(() => (window as any).getThree3DGeoView());
  expect(view.targetLat).toBeCloseTo(45.80025, 6);
  expect(view.targetLng).toBeCloseTo(15.9822, 6);
  expect(view.headingDeg).toBeCloseTo(20, 2);
  expect(view.pitchRad).toBeCloseTo(-0.65, 2);
  expect(view.range).toBeCloseTo(140, 0);
  await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'false');
  await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(sceneCounts).toEqual({ buildings: 2, parks: 2 });
  const after = await page.evaluate(() => (window as any).getThree3DGeoView());
  for (const key of Object.keys(view)) expect(after[key]).toBeCloseTo(view[key], 9);
  // Explicitly focusing one design remains a separate action from restoring the shared view.
  await page.evaluate(id => (window as any).showThreeModeDesign(id), id);
  await expect(page.locator('.three-mode-isolation-banner')).toBeVisible();
  await expect.poll(sceneCounts).toEqual({ buildings: 1, parks: 0 });
});

test('design links ignore a local key equal to the CID and fork ancestry, then reuse the exact imported copy', async ({ mockApi: author, browser, baseURL }) => {
  test.setTimeout(150_000);
  await openCity(author);
  await author.locator('#username-display').click();
  await author.locator('#username-input').fill('Link copy author');
  await author.locator('#welcome-submit-btn').click();
  await expect(author.locator('#welcome-modal')).toBeHidden();
  const authoredId = await createSpace(author, 'park');
  await showProposal(author, authoredId);
  await author.locator('#proposal-details-panel .btn-share-proposal').click();
  const index = pageIndex(author);
  await expect.poll(() => index.designs.size, { timeout: 30_000 }).toBe(1);
  const [cid] = [...index.designs.keys()];
  const title = String(index.designs.get(cid)!.title);

  const context = await browser.newContext({ baseURL });
  await context.addInitScript(() => {
    try {
      localStorage.setItem('cb_current_city', 'zagreb');
      localStorage.setItem('cb_site_intro_seen_v1', '1');
    } catch (_) { /* opaque origin */ }
  });
  const page = await context.newPage();
  try {
    await mockAllApiRoutes(page);
    await attachSharedIndex(page, index);
    await page.goto('/?city=zg&reduceMotion=1', { waitUntil: 'domcontentloaded' });
    await waitForMapReady(page);
    await page.waitForFunction(() => (window as any).ProposalManager?._initialReapplyDone === true);
    await page.evaluate(({ cid, parcelId }) => {
      const w = window as any;
      w.proposalStorage.addProposal({ proposalId: cid, title: 'Unrelated local key equal to the CID',
        goal: 'as-is', cadastreParcelIds: [parcelId], lifecycleStatus: 'Active' });
      w.proposalStorage.addProposal({ proposalId: 'p-local-fork', title: 'Separate local fork', goal: 'as-is',
        origin: { cid }, cadastreParcelIds: [parcelId], lifecycleStatus: 'Active' });
    }, { cid, parcelId: PARCEL_ID });

    const localId = `design-${cid}`;
    const first = await page.evaluate(cid => (window as any).handleSharedDesignRoute([cid], { summary: false, openDetails: false, enter3D: false })
      .then((result: any) => ({ applied: result.applied, skipped: result.skipped, failed: result.failed, localId: result.localIds.get(cid) })), cid);
    expect(first).toEqual({ applied: [localId], skipped: [], failed: [], localId });
    const records = await page.evaluate(() => {
      const w = window as any;
      return w.proposalStorage.peekAllProposals().map((p: any) => ({
        key: p.proposalId, title: p.title, cid: w.DesignSync.publishedCid(p), applied: !!w.isProposalCurrentlyApplied(p)
      }));
    });
    expect(records).toHaveLength(3);
    expect(records).toEqual(expect.arrayContaining([
      { key: cid, title: 'Unrelated local key equal to the CID', cid: null, applied: false },
      { key: 'p-local-fork', title: 'Separate local fork', cid: null, applied: false },
      { key: localId, title, cid, applied: true },
    ]));

    // Opened again, the link stands on the copy it imported: nothing is fetched into a second record.
    const again = await page.evaluate(cid => (window as any).handleSharedDesignRoute([cid], { summary: false, enter3D: false })
      .then((result: any) => ({ applied: result.applied, skipped: result.skipped, failed: result.failed })), cid);
    expect(again).toEqual({ applied: [], skipped: [localId], failed: [] });
    expect(await page.evaluate(() => (window as any).proposalStorage.peekAllProposals().length)).toBe(3);
    const design = page.locator('#click-stack .click-stack__section[data-kind="designs"]');
    await expect(design.locator('#proposal-details-panel')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#planning-inspector')).toBeHidden();
    await expect.poll(() => page.evaluate(() => (window as any).ProposalSelection?.getKey?.())).toBe(localId);

    // A fresh device follows the real URL into model mode, retaining its Design section while
    // the scene initializes. Actions return to that same design in the map's click panel.
    const modelContext = await browser.newContext({ baseURL });
    try {
      await modelContext.addInitScript(() => {
        try { localStorage.setItem('cb_site_intro_seen_v1', '1'); } catch (_) { /* opaque origin */ }
      });
      const model = await modelContext.newPage();
      await mockAllApiRoutes(model);
      await attachSharedIndex(model, index);
      await mockBuildingScene(model);
      await model.goto(`/designs/${cid}?city=zg&model&reduceMotion=1`, { waitUntil: 'domcontentloaded' });
      await expect(model.locator('body')).toHaveClass(/three-mode-active/, { timeout: 60_000 });
      const modelDesign = model.locator('#three-click-stack .click-stack__section[data-kind="designs"]');
      await expect(modelDesign).toHaveClass(/is-expanded/, { timeout: 30_000 });
      await expect(modelDesign).toContainText(title);
      await expect(model.locator('#planning-inspector')).toBeHidden();
      await expect(model.getByText('Authored proposal', { exact: true })).toHaveCount(0);
      await model.screenshot({ path: '/tmp/shared-design-model-click-panel.png' });
      await modelDesign.getByRole('button', { name: 'Design actions', exact: true }).click();
      await expect(model.locator('body')).not.toHaveClass(/three-mode-active/);
      await expect(model.locator('#click-stack .click-stack__section[data-kind="designs"] #proposal-details-panel')).toBeVisible();
      await expect(model.locator('#planning-inspector')).toBeHidden();
    } finally {
      await modelContext.close();
    }
  } finally {
    await context.close();
  }
});
