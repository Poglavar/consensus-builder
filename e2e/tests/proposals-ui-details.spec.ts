import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { selectors } from '../helpers/selectors';

test.describe('Proposal UI details flows @core', () => {
  test('opens proposal list modal correctly', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    await page.evaluate(async () => {
      const w = window as any;

      const prop = {
          proposalId: 'prop-details-123',
          name: 'List Test Proposal',
          type: 'road',
          author: 'Tester',
          parentParcelIds: ['HR-1']
      };

      if (typeof w.proposalStorage !== 'undefined' && w.proposalStorage.addProposal) {
          w.proposalStorage.addProposal(prop);
      }

      // We must provide a mock buildProposalElement to ensure it correctly renders
      // Our proposal uses 'parentParcelIds' for parcels check
      if (typeof w.showAllProposalsModal === 'function') {
          w.showAllProposalsModal();
      }
    });

    const listModal = page.locator('.proposal-list-modal');
    await expect(listModal).toBeVisible({ timeout: 5000 });

    // The modal renders "Untitled proposal" if it cannot get the display name correctly
    // Wait for list items to render. We should see the author 'Tester'
    await expect(listModal).toContainText('Tester');

    // There should be some sort of close button
    const closeBtn = listModal.locator('.proposal-list-modal-close, .close-circle-btn').first();
    await closeBtn.click();
    await expect(listModal).not.toBeVisible();
  });
});
