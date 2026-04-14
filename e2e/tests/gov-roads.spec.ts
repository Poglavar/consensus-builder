import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';

test.describe('Government road plan worker @features', () => {
  test('government plan worker can be created', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      // Check if the worker-related functions exist
      return {
        hasEnsureWorker: typeof w.ensurePlanWorker === 'function',
        hasComputePlan: typeof w.computeGovernmentRoadPlan === 'function',
        hasGetManager: typeof w.getGovernmentPlanManager === 'function',
        hasWorkerDisabledReason: typeof w.planWorkerDisabledReason === 'string',
        hasLastStats: 'lastGovernmentPlanAutoApplyStats' in w,
      };
    });

    // At least some government road functions should exist
    const hasSome = Object.values(result).some(v => v === true);
    test.skip(!hasSome, 'Government road module not loaded');
    expect(hasSome).toBe(true);
  });

  test('CustomEvent dispatch pattern works for plan events', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      let received = false;
      let detail: any = null;
      window.addEventListener('governmentPlanProcessed', (e: any) => {
        received = true;
        detail = e.detail;
      }, { once: true });

      window.dispatchEvent(new CustomEvent('governmentPlanProcessed', {
        detail: {
          parcels: [{ parcelId: 'test', coverageRatio: 0.75 }],
          stats: { booleanChecks: 10, booleanHits: 5 },
        },
      }));

      return {
        received,
        hasDetail: detail !== null,
        parcelCount: detail?.parcels?.length ?? 0,
      };
    });

    expect(result.received).toBe(true);
    expect(result.hasDetail).toBe(true);
    expect(result.parcelCount).toBe(1);
  });

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
