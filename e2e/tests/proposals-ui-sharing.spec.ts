import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { selectors } from '../helpers/selectors';

test.describe('Proposal UI sharing flows @core', () => {
  test('share modal opens with correct link when generating link', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    await page.evaluate(async () => {
      const w = window as any;
      w.userProfile = { name: 'Test', lensHandle: 'test.lens' };
      w.getCurrentUserAgent = () => ({ isGuest: false, name: 'Test' });

      // We need to inject a proposal into the proposalStorage and make it applied
      if (typeof w.proposalStorage !== 'undefined' && w.proposalStorage.addProposal) {
          const prop = {
              proposalId: 'prop-1234',
              name: 'Test Road',
              type: 'road',
              parcels: ['HR-1'],
              serverId: '123'  // It requires numeric serverId to be considered uploaded
          };
          w.proposalStorage.addProposal(prop);

          if (w.appliedProposals && w.appliedProposals.add) {
              w.appliedProposals.add('prop-1234');
          }
      }

      // Override isProposalCurrentlyApplied
      w.isProposalCurrentlyApplied = (p: any) => true;

      // The modal uses fetch to check metadata for numeric ids
      w.fetch = async () => ({
          ok: true,
          json: async () => ({ id: '123' }),
          headers: new Map()
      });

      // Attempt to share applied proposals
      if (typeof w.showSharePlanModal === 'function') {
          w.showSharePlanModal();
      }
    });

    const shareModal = page.locator('.share-plan-modal, .share-modal, #sharePlanModal, .modal-overlay').first();
    await expect(shareModal).toBeVisible({ timeout: 5000 });

    await expect(page.locator('text=Share Plan')).toBeVisible();

    // Look for the input field with the link - it might take a second for the "check upload status" to finish
    const linkInput = page.locator('.share-modal-body input[type="text"]');
    await expect(linkInput).toBeVisible({ timeout: 5000 });

    const value = await linkInput.inputValue();
    expect(value).toContain('proposals/123');

    // Close modal
    const closeBtn = page.getByRole('button', { name: 'Close', exact: true });
    await closeBtn.click();
    await expect(page.locator('text=Share Plan')).not.toBeVisible();
  });
});
