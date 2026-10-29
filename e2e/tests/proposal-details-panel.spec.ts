import { test, expect } from '../helpers/fixtures';
import { openCity, PARCEL_ID, stackSection } from '../helpers/runtime';

test.describe('Proposal details panel @features', () => {
  test('collapsing the Design section preserves its context across a map pan', async ({ mockApi: page }) => {
    await openCity(page);
    const proposalId = await page.evaluate((parcelId) => {
      const w = window as any;
      return w.proposalStorage.addProposal({
        title: 'E2E proposal collapse',
        goal: 'park',
        lifecycleStatus: 'Active',
        lifecycleEvidence: { protocol: 'proposal-lifecycle-evidence/1', state: 'unknown', claimedStatus: 'Active', reason: 'no-matching-observation' },
        cadastreParcelIds: [parcelId],
      });
    }, PARCEL_ID);
    await page.locator('#proposals-button').click();
    // Lists: a design row's Open opens its details.
    await page.locator(`#proposal-list-host .lists-item[data-list-id="${proposalId}"] .lists-item__open`).click();
    await expect(page.locator('#planning-inspector')).toBeHidden();
    await expect.poll(() => page.evaluate(() => (window as any).currentlyHighlightedProposalId)).toBe(proposalId);
    const section = stackSection(page, 'designs');
    const row = section.locator('.click-stack__row');
    const panel = section.locator('#proposal-details-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('#proposal-details-minimize')).toBeHidden();
    await row.click();
    await expect(row).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#proposal-details-panel')).toBeHidden();

    await page.evaluate(() => new Promise<void>((resolve) => {
      const map = (window as any).map;
      map.once('moveend', () => resolve());
      map.panBy([120, 0], { animate: false });
    }));
    const afterPan = await page.evaluate((id) => ({
      proposalId: (window as any).ClickStack.current().sections.find((s: any) => s.kind === 'designs').instances[0].id,
      expanded: (window as any).ClickStack.current().expanded,
      lifecycleEvidence: (window as any).proposalStorage.getProposal(id)?.lifecycleEvidence,
    }), proposalId);
    expect(afterPan.proposalId).toBe(proposalId);
    expect(afterPan.expanded).toBeNull();
    expect(afterPan.lifecycleEvidence).toMatchObject({
      protocol: 'proposal-lifecycle-evidence/1', state: 'unknown', claimedStatus: 'Active',
    });

    await row.click();
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    await expect(section.locator('#proposal-details-panel .panel-body')).toBeVisible();
  });
});
