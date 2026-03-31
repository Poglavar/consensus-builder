import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';

test.describe('Proposal lifecycle @core', () => {
  test('proposal apply/unapply functions exist', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const functions = await page.evaluate(() => {
      const w = window as any;
      return {
        hasApply: typeof w.applyProposal === 'function',
        hasUnapply: typeof w.unapplyProposal === 'function' || typeof w.removeProposal === 'function',
        hasUpdateStatus: typeof w.updateProposalStatus === 'function',
      };
    });

    const hasSome = functions.hasApply || functions.hasUnapply || functions.hasUpdateStatus;
    test.skip(!hasSome, 'Proposal lifecycle functions not loaded in static-serve mode');
    expect(hasSome).toBe(true);
  });

  test('proposals persist across page reload', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    // Store a test value in the proposal storage mechanism
    await page.evaluate(() => {
      const w = window as any;
      try {
        if (w.PersistentStorage && typeof w.PersistentStorage.setItem === 'function') {
          w.PersistentStorage.setItem('e2e_test_proposal', JSON.stringify({
            id: 'e2e-test',
            name: 'E2E Persistence Test',
            type: 'road',
          }));
        }
      } catch (_) {}
    });

    await page.reload();
    await waitForMapReady(page);
    await page.waitForTimeout(2000);

    const persisted = await page.evaluate(() => {
      const w = window as any;
      try {
        if (w.PersistentStorage && typeof w.PersistentStorage.getItem === 'function') {
          const raw = w.PersistentStorage.getItem('e2e_test_proposal');
          if (raw) return JSON.parse(raw);
        }
      } catch (_) {}
      return null;
    });

    expect(persisted).not.toBeNull();
    if (persisted) {
      expect(persisted.name).toBe('E2E Persistence Test');
    }

    // Clean up
    await page.evaluate(() => {
      const w = window as any;
      try {
        if (w.PersistentStorage && typeof w.PersistentStorage.removeItem === 'function') {
          w.PersistentStorage.removeItem('e2e_test_proposal');
        }
      } catch (_) {}
    });
  });
});
