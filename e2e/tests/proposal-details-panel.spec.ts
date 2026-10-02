import { test, expect } from '../helpers/fixtures';
import { openCity, PARCEL_ID } from '../helpers/runtime';

test.describe('Proposal details panel @features', () => {
  test('minimizing preserves the selected proposal across a map pan', async ({ mockApi: page }) => {
    await openCity(page);
    const proposalId = await page.evaluate((parcelId) => {
      const w = window as any;
      return w.proposalStorage.addProposal({
        title: 'E2E proposal minimize',
        goal: 'parcelBased',
        lifecycleStatus: 'Active',
        cadastreParcelIds: [parcelId],
      });
    }, PARCEL_ID);
    const opened = await page.evaluate(id => (window as any).openProposalFromList(id, {
      closeProposalList: true,
      closeParcelInfo: true,
      centerOnProposal: false,
      showDetails: true,
      showSelection: false,
    }), proposalId);
    expect(opened).toBe(true);

    const panel = page.locator('#proposal-details-panel');
    const minimizeButton = panel.locator('#proposal-details-minimize');
    const body = panel.locator('.panel-body');
    await expect(panel).toBeVisible();
    // Opening from the proposals list deliberately presents this secondary panel collapsed.
    await expect(panel).toHaveClass(/is-minimized/);
    await expect(minimizeButton).toHaveAttribute('aria-expanded', 'false');
    await minimizeButton.click();
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
    const afterPan = await page.evaluate(() => ({
      proposalId: (window as any).currentlyHighlightedProposalId,
      panelVisible: document.getElementById('proposal-details-panel')?.classList.contains('visible'),
      minimized: document.getElementById('proposal-details-panel')?.classList.contains('is-minimized'),
    }));
    expect(afterPan.proposalId).toBe(proposalId);
    expect(afterPan.panelVisible).toBe(true);
    expect(afterPan.minimized).toBe(true);

    await minimizeButton.click();
    await expect(minimizeButton).toHaveAttribute('aria-expanded', 'true');
    await expect(body).toBeVisible();
  });
});
