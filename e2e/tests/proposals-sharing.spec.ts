import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';

/**
 * Proposal sharing — the part that genuinely needs a browser.
 *
 * Four tests were dropped from this file. `sharing utility functions are available` was a
 * `typeof x === 'function'` roll-call; `backend base URL resolves to a valid URL` duplicated
 * data-source.spec.ts; and the base64 round-trip and escapeHtml tests were pure functions that now
 * run in node (backend/test/proposals-sharing-utils.test.js) in well under a millisecond each.
 *
 * What is left needs the real proposalStorage and the real parcel-layer index.
 */

test.describe('Proposal sharing @core', () => {
  // A shared proposal arrives ALREADY marked applied, carrying the SENDER's childParcelIds —
  // slice ids this browser never generated. isParcelReplacedByChildren must not treat the parent
  // as consumed on the strength of those foreign ids alone: ten call sites key off it (the
  // shared-link parcel fetcher, the recovery paths, ingest), and every one of them drops the
  // parent when it answers yes. With the parent gone and the slices never generated, the proposal
  // still draws — its visuals are interactive:false and come from proposal data — over a
  // parcel-shaped hole with nothing to click. That is the "visible after reload, but dead" bug.
  test('a parent is replaced only when a replacement slice exists on THIS device', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      if (typeof w.isParcelReplacedByChildren !== 'function'
        || !w.proposalStorage
        || typeof w.getParcelLayerIdMap !== 'function') {
        return { skip: true };
      }

      const layerIndex = w.getParcelLayerIdMap();
      const parcelId = 'HR-000000-9999';
      const sliceId = `${parcelId}#p-sharedfromelsewhere-1`;

      w.proposalStorage.importProposal({
        proposalId: 'p-sharedfromelsewhere',
        title: 'Shared from another device',
        status: 'Applied',
        goal: 'road',
        parentParcelIds: [parcelId],
        childParcelIds: [sliceId],
        roadProposal: { status: 'applied', parentParcelIds: [parcelId], childParcelIds: [sliceId] },
      }, { overwrite: true, preserveStatus: true });
      w.proposalStorage._indexProposal?.(w.proposalStorage.getProposal('p-sharedfromelsewhere'));

      // The sender's slice was never generated here -> the parent must survive.
      const replacedWithoutSlice = w.isParcelReplacedByChildren(parcelId);

      // Once a replacement slice really is on this device, the parent is genuinely superseded.
      // (The predicate only scans the index's keys, so a placeholder entry is enough.)
      layerIndex.set(sliceId, { __testPlaceholder: true });
      const replacedWithSlice = w.isParcelReplacedByChildren(parcelId);

      layerIndex.delete(sliceId);

      return { skip: false, replacedWithoutSlice, replacedWithSlice };
    });

    test.skip(result.skip === true, 'Proposal storage / parcel index not loaded');
    expect(result.replacedWithoutSlice, 'parent must NOT be replaced when its slices are absent here').toBe(false);
    expect(result.replacedWithSlice, 'parent MUST still be replaced once a slice exists here').toBe(true);
  });
});
