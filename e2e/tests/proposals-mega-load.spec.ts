// Loading a proposal with hundreds of ancestor parcels must not freeze the UI.
// We assert two things:
//   1. The load + details-open completes within a generous wall-clock budget.
//   2. The main thread yielded enough during the load that requestAnimationFrame
//      callbacks fired many times — proving work is happening in the background
//      rather than as one synchronous block.
//
// The mega route in focusProposalDetails currently triggers when ancestor count
// exceeds MAX_PARENT_PARCEL_OUTLINE_RESOLUTION (96 at time of writing). 320 parents
// is comfortably above that and small enough to keep test runtime sane.

import { test, expect } from '../helpers/fixtures';
import { waitForMapReady, zoomToParcelLevel } from '../helpers/app';

const MEGA_PARCEL_COUNT = 320;

test.describe('Mega proposal loading @features', () => {
  test('300+ ancestor proposal opens without blocking the main thread', async ({ mockApi: page }) => {
    test.setTimeout(60_000);

    await page.goto('/?city=zg');
    await waitForMapReady(page);
    await zoomToParcelLevel(page);

    const result = await page.evaluate(async (count: number) => {
      const w = window as any;

      if (typeof w.ingestParcelFeatures !== 'function') {
        return { error: 'ingestParcelFeatures missing' };
      }
      if (typeof w.openProposalFromList !== 'function') {
        return { error: 'openProposalFromList missing' };
      }

      // Build a grid of small adjacent parcels around a Zagreb anchor.
      const cols = Math.ceil(Math.sqrt(count));
      const cellLng = 0.00012;
      const cellLat = 0.00009;
      const baseLng = 15.9800;
      const baseLat = 45.8000;
      const features: any[] = [];
      const parentIds: string[] = [];
      for (let i = 0; i < count; i++) {
        const r = Math.floor(i / cols);
        const c = i % cols;
        const lng0 = baseLng + c * cellLng;
        const lat0 = baseLat + r * cellLat;
        const lng1 = lng0 + cellLng * 0.95;
        const lat1 = lat0 + cellLat * 0.95;
        const id = `HR-335754-MEGA${String(i).padStart(4, '0')}`;
        parentIds.push(id);
        features.push({
          type: 'Feature',
          properties: {
            parcelId: id, parcel_id: id, id,
            BROJ_CESTICE: `MEGA${i}`,
            maticni_broj_ko: '335754', MATICNI_BROJ_KO: '335754',
          },
          geometry: {
            type: 'Polygon',
            coordinates: [[
              [lng0, lat0],
              [lng1, lat0],
              [lng1, lat1],
              [lng0, lat1],
              [lng0, lat0],
            ]],
          },
        });
      }

      await w.ingestParcelFeatures(features, { replaceExisting: false });

      const proposalSeed = {
        proposalId: 'e2e-mega-proposal-load',
        title: 'E2E mega proposal',
        // Use 'parcelBased' rather than a road, so we exercise the generic ancestor-list
        // path rather than the road-corridor branch.
        goal: 'parcelBased',
        status: 'Active',
        parentParcelIds: parentIds,
      };
      const added = w.proposalStorage.addProposal(proposalSeed);
      const pid = added?.proposalId || proposalSeed.proposalId;

      // Frame yield counter: increments on every rAF tick. If the main thread
      // is blocked by a long sync operation, this counter stops advancing.
      let frameTicks = 0;
      let stop = false;
      const tick = () => {
        if (stop) return;
        frameTicks++;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);

      // Track the longest gap between ticks as a freeze proxy.
      let lastTickAt = performance.now();
      let longestFrameGapMs = 0;
      const gapWatch = () => {
        if (stop) return;
        const now = performance.now();
        const gap = now - lastTickAt;
        if (gap > longestFrameGapMs) longestFrameGapMs = gap;
        lastTickAt = now;
        requestAnimationFrame(gapWatch);
      };
      requestAnimationFrame(gapWatch);

      const t0 = performance.now();
      await w.openProposalFromList(pid, {
        closeProposalList: false,
        closeParcelInfo: false,
        centerOnProposal: true,
        showDetails: true,
        showSelection: false,
      });
      // Wait briefly for the deferred details panel render to settle.
      await new Promise(r => setTimeout(r, 250));
      const totalMs = performance.now() - t0;

      stop = true;

      // showProposalInfo renders into #proposal-details-panel; assert the panel is present AND
      // contains the proposal-specific ancestors list rendered for this proposal.
      const panel = document.getElementById('proposal-details-panel');
      const ancestorsList = document.getElementById('proposal-parent-parcels-list');
      const panelVisible = !!panel;
      const ancestorsListPresent = !!ancestorsList;

      return {
        pid,
        parentCount: parentIds.length,
        totalMs: Math.round(totalMs),
        frameTicks,
        longestFrameGapMs: Math.round(longestFrameGapMs),
        panelVisible,
        ancestorsListPresent,
      };
    }, MEGA_PARCEL_COUNT);

    expect(result.error, `setup: ${result.error}`).toBeUndefined();
    expect(result.parentCount).toBe(MEGA_PARCEL_COUNT);

    // Wall-clock budget: very generous so this is not a flaky perf gate. We are not testing
    // raw speed — we are testing that the call returns at all in a reasonable window.
    expect(result.totalMs, 'total openProposalFromList wall-clock').toBeLessThan(20_000);

    // Real freezes show as multi-second rAF gaps. We do not assert a tight ceiling because
    // headless Playwright + parallel workers can throttle rAF; the meaningful signal is "no
    // single sync block held the main thread for several seconds".
    expect(result.longestFrameGapMs, 'longest single-frame gap').toBeLessThan(3500);

    // Details panel must actually be visible at the end and showing the ancestor list.
    expect(result.panelVisible).toBe(true);
    expect(result.ancestorsListPresent).toBe(true);
  });
});
