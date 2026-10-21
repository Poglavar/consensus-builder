import { test, expect } from '../helpers/fixtures';
import { openCity, PARCEL_ID, showProposal } from '../helpers/runtime';

test.describe('Proposal details panel @features', () => {
  test('minimizing preserves the selected proposal across a map pan', async ({ mockApi: page }) => {
    await openCity(page);
    const proposalId = await page.evaluate((parcelId) => {
      const w = window as any;
      return w.proposalStorage.addProposal({
        title: 'E2E proposal minimize',
        goal: 'park',
        lifecycleStatus: 'Active',
        lifecycleEvidence: { protocol: 'proposal-lifecycle-evidence/1', state: 'unknown', claimedStatus: 'Active', reason: 'no-matching-observation' },
        cadastreParcelIds: [parcelId],
      });
    }, PARCEL_ID);
    await page.locator('#proposals-button').click();
    await page.locator(`.proposal-list-item[data-proposal-id="${proposalId}"] .proposal-list-details-btn`).click();
    await expect(page.locator('#planning-inspector')).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).currentlyHighlightedProposalId)).toBe(proposalId);
    await showProposal(page, proposalId);

    const panel = page.locator('#proposal-details-panel');
    const minimizeButton = panel.locator('#proposal-details-minimize');
    const body = panel.locator('.panel-body');
    await expect(panel).toBeVisible();
    // The list's Details action opens the reader; minimizing is the user's explicit choice.
    await expect(panel).not.toHaveClass(/is-minimized/);
    await expect(body).toBeVisible();
    await minimizeButton.click();
    await expect(panel).toHaveClass(/is-minimized/);
    await expect(minimizeButton).toHaveAttribute('aria-expanded', 'false');
    await expect(body).toBeHidden();

    await page.evaluate(() => new Promise<void>((resolve) => {
      const map = (window as any).map;
      map.once('moveend', () => resolve());
      map.panBy([120, 0], { animate: false });
    }));
    const afterPan = await page.evaluate((id) => ({
      proposalId: (window as any).currentlyHighlightedProposalId,
      panelVisible: document.getElementById('proposal-details-panel')?.classList.contains('visible'),
      minimized: document.getElementById('proposal-details-panel')?.classList.contains('is-minimized'),
      lifecycleEvidence: (window as any).proposalStorage.getProposal(id)?.lifecycleEvidence,
    }), proposalId);
    expect(afterPan.proposalId).toBe(proposalId);
    expect(afterPan.panelVisible).toBe(true);
    expect(afterPan.minimized).toBe(true);
    expect(afterPan.lifecycleEvidence).toMatchObject({
      protocol: 'proposal-lifecycle-evidence/1', state: 'unknown', claimedStatus: 'Active',
    });

    await minimizeButton.click();
    await expect(minimizeButton).toHaveAttribute('aria-expanded', 'true');
    await expect(body).toBeVisible();
  });
});
