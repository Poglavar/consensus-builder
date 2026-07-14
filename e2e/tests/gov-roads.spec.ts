import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';

/**
 * Government road plan. Both tests here are browser-bound: one asserts the Web Worker is actually
 * enabled when served over HTTP, the other spies on the real turf.union to prove drawing the plan
 * does not eagerly union it on the main thread.
 *
 * Two tests were dropped. One was a `typeof ensurePlanWorker === 'function'` roll-call that named
 * globals the app no longer exposes, so it skipped itself on every run. The other dispatched its own
 * `governmentPlanProcessed` CustomEvent and asserted it received it — that tests the browser's event
 * system, not the plan pipeline.
 */

test.describe('Government road plan worker @features', () => {
  test('Web Worker is accessible for government plan processing', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      // Test that Web Workers are available in this environment
      const hasWorker = typeof Worker !== 'undefined';

      const w = window as any;
      // Check if worker was disabled (e.g., file:// protocol)
      const workerDisabledReason = w.planWorkerDisabledReason || null;
      const workerAvailable = hasWorker && !workerDisabledReason;

      return {
        hasWorkerAPI: hasWorker,
        workerDisabledReason,
        workerAvailable,
      };
    });

    expect(result.hasWorkerAPI).toBe(true);
    // Worker should be available when served via HTTP
    expect(result.workerAvailable).toBe(true);
  });

  test('drawing the government plan does not eagerly union the plan on the main thread', async ({ mockApi: page }) => {
    await page.route('**/planned-road**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: { road_name: 'Plan A' },
              geometry: {
                type: 'Polygon',
                coordinates: [[
                  [15.98, 45.80],
                  [15.985, 45.80],
                  [15.985, 45.805],
                  [15.98, 45.805],
                  [15.98, 45.80],
                ]],
              },
            },
            {
              type: 'Feature',
              properties: { road_name: 'Plan B' },
              geometry: {
                type: 'Polygon',
                coordinates: [[
                  [15.986, 45.80],
                  [15.991, 45.80],
                  [15.991, 45.805],
                  [15.986, 45.805],
                  [15.986, 45.80],
                ]],
              },
            },
          ],
        }),
      });
    });

    await page.goto('/');
    await waitForMapReady(page);

    await page.evaluate(() => {
      const w = window as any;
      if (!w.turf || typeof w.turf.union !== 'function') {
        throw new Error('Expected Turf to be loaded for the government road test.');
      }
      let unionCalls = 0;
      const originalUnion = w.turf.union.bind(w.turf);
      w.__governmentPlanUnionCalls = () => unionCalls;
      w.turf.union = (...args: any[]) => {
        unionCalls += 1;
        return originalUnion(...args);
      };
    });

    await page.evaluate(() => {
      const checkbox = document.getElementById('showGovernmentRoadPlan') as HTMLInputElement | null;
      if (!checkbox) {
        throw new Error('Government road plan checkbox not found.');
      }
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await page.waitForFunction(() => {
      const w = window as any;
      return !!(w.governmentRoadPlanLayer
        && typeof w.governmentRoadPlanLayer.getLayers === 'function'
        && w.governmentRoadPlanLayer.getLayers().length > 0);
    });

    const result = await page.evaluate(() => {
      const w = window as any;
      return {
        unionCalls: typeof w.__governmentPlanUnionCalls === 'function' ? w.__governmentPlanUnionCalls() : -1,
        featureCount: (w.governmentRoadPlanLayer && typeof w.governmentRoadPlanLayer.getLayers === 'function')
          ? w.governmentRoadPlanLayer.getLayers().length
          : 0,
      };
    });

    expect(result.featureCount).toBeGreaterThan(0);
    expect(result.unionCalls).toBe(0);
  });
});
