// Verify multi-tab protection and auxiliary page controls through their visible UI outcomes.
import { test, expect } from '../helpers/fixtures';
import { createSpace, openCity } from '../helpers/runtime';
import { waitForMapReady } from '../helpers/app';
import { mockAllApiRoutes } from '../helpers/mocks/api-routes';

test.describe('Supporting tertiary controls @core', () => {
  test('multi-tab Dismiss hides the warning but preserves read-only protection and recoverable work', async ({ mockApi: primary, context }) => {
    test.setTimeout(60_000);
    await openCity(primary);

    const secondary = await context.newPage();
    await mockAllApiRoutes(secondary);
    await secondary.goto('/?city=zg&reduceMotion=1', { waitUntil: 'domcontentloaded' });
    await waitForMapReady(secondary);

    const banner = secondary.locator('#cb-multitab-banner');
    const isSecondary = (page: import('@playwright/test').Page) => page.evaluate(() => !!(window as any).__cbSecondaryTab);
    await expect(banner).toBeVisible({ timeout: 15_000 });
    expect(await isSecondary(secondary)).toBe(true);

    await banner.getByRole('button', { name: 'Close' }).click();
    await expect(banner).toHaveCount(0);
    expect(await isSecondary(secondary)).toBe(true);

    // A real creation through the parcel menu attempts persistence. The secondary tab parks the
    // proposal for recovery, keeps it out of the primary tab's store, and restores the warning.
    const proposalId = await createSpace(secondary, 'park');
    await expect(banner).toBeVisible({ timeout: 5_000 });
    await expect(banner).toContainText('already open in another tab');
    await expect(banner).toContainText('recovery copy');
    // The banner is the one message: no toast repeats it.
    await expect(secondary.locator('#ephemeral-message-container', { hasText: 'another tab' })).toHaveCount(0);
    expect(await isSecondary(secondary)).toBe(true);
    expect(await secondary.evaluate(id => (window as any).proposalStorage.getAllProposals().some((p: any) => String(p.proposalId) === id), proposalId)).toBe(true);
    expect(await primary.evaluate(id => (window as any).proposalStorage.getAllProposals().some((p: any) => String(p.proposalId) === id), proposalId)).toBe(false);
    expect(await secondary.evaluate(id => {
      const saved = JSON.parse((window as any).PersistentStorage.getItem('cadastre_proposals_recovery') || '{}');
      return Array.isArray(saved.records) && saved.records.some((p: any) => String(p.proposalId || p.id) === id);
    }, proposalId)).toBe(true);
  });
});
