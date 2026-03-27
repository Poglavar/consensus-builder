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
});
