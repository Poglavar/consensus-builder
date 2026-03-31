import { test, expect } from '../helpers/fixtures';
import { waitForMapReady, zoomToParcelLevel } from '../helpers/app';
import { selectors } from '../helpers/selectors';

test.describe('Proposal UI creation flows @core', () => {
  test('create road/track proposal enables submit when geometry added', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    await page.evaluate(async () => {
      const w = window as any;
      w.userProfile = { name: 'Test', lensHandle: 'test.lens' };
      w.getCurrentUserAgent = () => ({ isGuest: false, name: 'Test' });

      const feature = {
        type: 'Feature',
        properties: { id: 'HR-TEST', calculatedArea: 100 },
        geometry: { type: 'Polygon', coordinates: [[[0,0], [1,0], [1,1], [0,1], [0,0]]] }
      };

      w.getCurrentParcelSelectionContext = () => ({
          ids: ['HR-TEST'],
          singleId: 'HR-TEST',
          mode: 'single',
          layers: [{ feature }]
      });
      w.selectedParcels = [{ feature }];
      w.currentParcel = { layer: { feature }, id: 'HR-TEST' };

      w.showProposalDialog();
    });

    const modalInput = page.locator('#proposalName');
    await expect(modalInput).toBeVisible({ timeout: 5000 });

    const roadTrackBtn = page.getByRole('button', { name: 'Road/Track' });
    await expect(roadTrackBtn).toBeVisible();
    await roadTrackBtn.click();

    const hint = page.locator('#proposalGeometryRequirementHint');
    await expect(hint).toContainText('Please add a geometry first.');

    const submitBtn = page.getByRole('button', { name: 'Create Proposal' });
    await expect(submitBtn).toBeDisabled();

    await page.evaluate(() => {
        const w = window as any;
        if (typeof w.setGeometryStatus === 'function') {
            w.setGeometryStatus('Geometry added', { submitted: true });
        }

        // Let's completely override createProposal to just close the modal for test purposes
        // We know the button enables properly, we don't need to test the entire backend upload logic here
        w.createProposal = async () => {
            if (typeof w.closeProposalDialog === 'function') {
                w.closeProposalDialog();
            }
        };
    });

    await expect(submitBtn).toBeEnabled();
    await submitBtn.click();

    // Modal should close
    await expect(modalInput).not.toBeVisible({ timeout: 5000 });
  });
});
