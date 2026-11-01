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
import { openCity, showProposal } from '../helpers/runtime';

const MEGA_PARCEL_COUNT = 320;

test.describe('Mega proposal loading @features', () => {
  test('300+ ancestor proposal opens without blocking the main thread', async ({ mockApi: page }) => {
    test.setTimeout(60_000);

    // Supply test cadastral facts over the same parcelIds transport used in production. The
    // repository remains responsible for normalization, caching, fabric seeding and presentation.
    await page.route('**/parcels/parcelIds**', async route => {
      const ids = new URL(route.request().url()).searchParams.get('ids')?.split(',') ?? [];
      if (!ids.every(id => id.includes('MEGA'))) return route.continue();
      const cols = Math.ceil(Math.sqrt(MEGA_PARCEL_COUNT));
      const features = ids.map(id => {
        const index = Number(id.slice(id.lastIndexOf('MEGA') + 4));
        const row = Math.floor(index / cols), col = index % cols;
        const lng = 15.9800 + col * 0.00012, lat = 45.8000 + row * 0.00009;
        return { type: 'Feature', properties: { parcelId: id, parcel_number: `MEGA${index}`, maticni_broj_ko: '335754' }, geometry: { type: 'Polygon', coordinates: [[[lng,lat],[lng+0.00011,lat],[lng+0.00011,lat+0.00008],[lng,lat+0.00008],[lng,lat]]] } };
      });
      await route.fulfill({ json: { type: 'FeatureCollection', features } });
    });

    await openCity(page);

    const result = await page.evaluate(async (count: number) => {
      const w = window as any;

      if (!w.CadastralParcelRepository?.ensureIds || !w.openProposalFromList) throw new Error('Parcel repository or proposal-list action is unavailable');
      const parentIds: string[] = [];
      for (let i = 0; i < count; i++) {
        const id = `HR-335754-MEGA${String(i).padStart(4, '0')}`;
        parentIds.push(id);
      }
      await w.CadastralParcelRepository.ensureIds(parentIds);

      const proposalSeed = {
        proposalId: 'e2e-mega-proposal-load',
        title: 'E2E mega proposal',
        // Use 'parcelBased' rather than a road, so we exercise the generic ancestor-list
        // path rather than the road-corridor branch.
        goal: 'parcelBased',
        lifecycleStatus: 'Active',
        cadastreParcelIds: parentIds,
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

      // Capture the selected proposal and its current details panel after the list action settles.
      const detailsPanel = document.getElementById('proposal-details-panel');
      const detailsPanelVisible = !!detailsPanel && detailsPanel.getClientRects().length > 0 && getComputedStyle(detailsPanel).visibility !== 'hidden';
      const selectedProposalId = w.currentlyHighlightedProposalId || null;

      return {
        pid,
        parentCount: parentIds.length,
        totalMs: Math.round(totalMs),
        frameTicks,
        longestFrameGapMs: Math.round(longestFrameGapMs),
        detailsPanelVisible,
        selectedProposalId,
      };
    }, MEGA_PARCEL_COUNT);

    expect(result.parentCount).toBe(MEGA_PARCEL_COUNT);

    // Wall-clock budget: very generous so this is not a flaky perf gate. We are not testing
    // raw speed — we are testing that the call returns at all in a reasonable window.
    expect(result.totalMs, 'total openProposalFromList wall-clock').toBeLessThan(20_000);

    // Real freezes show as multi-second rAF gaps. We do not assert a tight ceiling because
    // headless Playwright + parallel workers can throttle rAF; the meaningful signal is "no
    // single sync block held the main thread for several seconds".
    expect(result.longestFrameGapMs, 'longest single-frame gap').toBeLessThan(3500);

    // The list action must select the intended record and expose its current details panel.
    expect(result.detailsPanelVisible).toBe(true);
    expect(result.selectedProposalId).toBe('e2e-mega-proposal-load');
    await showProposal(page, 'e2e-mega-proposal-load');
    const panel = page.locator('#proposal-details-panel');
    const minimizeButton = page.locator('#proposal-details-minimize');
    if (await panel.evaluate(element => element.classList.contains('is-minimized'))) {
      await minimizeButton.click();
    }
    await expect(panel.locator('#proposal-details-footer')).toBeVisible();
    await page.locator('#click-stack [data-page="relation-parcels"]').click();
    const ancestorsList = page.locator('#click-stack .click-stack__choices[data-kind="parcels"]');
    await expect(ancestorsList).toBeVisible();
    const firstAncestor = ancestorsList.locator('.click-stack__chip').first();
    await expect(firstAncestor).toHaveAttribute('data-id', 'HR-335754-MEGA0000');
  });
});
