import { selectNativeOption } from '../helpers/controls';
import { test, expect } from '../helpers/fixtures';
import { clickMapPoint, openCity, openParcel, PARCEL_GEOMETRY, PARCEL_ID, proposalState, showProposal } from '../helpers/runtime';

const SOLANA_WALLET = '7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT';
const PROPOSAL_ACCOUNT = '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg';

async function expandProposalDetails(page: import('@playwright/test').Page): Promise<void> {
  const expand = page.locator('#proposal-details-panel').getByRole('button', { name: 'Expand', exact: true });
  if (await expand.isVisible()) await expand.click();
}

test.describe('Proposal browsing @features', () => {
  test('local list filters, sorts and switches proposal sources through visible controls', async ({ mockApi: page }) => {
    await openCity(page);
    const ids = await page.evaluate((parcelId) => {
      const w = window as any;
      return [
        w.proposalStorage.addProposal({ title: 'North park plan', goal: 'park', author: 'Ada', createdAt: '2024-01-01T00:00:00Z', lifecycleStatus: 'Active', cadastreParcelIds: [parcelId] }),
        w.proposalStorage.addProposal({ title: 'South park plan', goal: 'park', author: 'Bea', createdAt: '2025-01-01T00:00:00Z', lifecycleStatus: 'Active', cadastreParcelIds: [parcelId] }),
        w.proposalStorage.addProposal({ title: 'Road safety plan', goal: 'road-track', author: 'Ada', createdAt: '2023-01-01T00:00:00Z', lifecycleStatus: 'Active', cadastreParcelIds: [parcelId] }),
      ];
    }, PARCEL_ID);

    // The Proposals sheet mounts the list itself (fbe3758d).
    await page.locator('#proposals-button').click();
    const list = page.locator('#proposals-sheet .proposal-list-modal');
    await expect(list.locator('.proposal-list-item')).toHaveCount(3);
    // The list sits in the capped 340px Proposals sheet (fbe3758d); on this 720px-tall window the
    // filters fold behind the Filters toggle so the list keeps its height.
    await expect(list.locator('.proposal-list-item').first()).toBeInViewport();
    await expect(list.locator('#proposal-list-controls')).toBeHidden();
    await list.locator('.proposal-filters-toggle').click();
    await expect(list.locator('.proposal-filters-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(list.locator('#proposal-list-controls')).toBeVisible();
    await list.locator('#proposal-filter-search').fill('North');
    await expect(list.locator('.proposal-list-item')).toHaveCount(1);
    await expect(list.locator('.proposal-list-title')).toHaveText('North park plan');

    await list.locator('#proposal-filter-search').fill('');
    await selectNativeOption(list.locator('#proposal-filter-type'), 'park');
    await expect(list.locator('.proposal-list-item')).toHaveCount(2);
    await selectNativeOption(list.locator('#proposal-sort'), 'created-asc');
    await expect(list.locator('.proposal-list-item').first().locator('.proposal-list-title')).toHaveText('North park plan');
    await expect(list.locator('.proposal-list-item').last().locator('.proposal-list-title')).toHaveText('South park plan');

    await list.locator('.proposal-source-btn[data-source="blockchain"]').click();
    await expect(list.locator('.proposal-source-btn[data-source="blockchain"]')).toHaveAttribute('aria-pressed', 'true');
    await list.locator('.proposal-source-btn[data-source="local"]').click();
    await expect(list.locator('.proposal-list-item')).toHaveCount(2);
    await list.locator('.proposal-source-btn[data-source="server"]').click();
    await expect(list.locator('.proposal-source-btn[data-source="server"]')).toHaveAttribute('aria-pressed', 'true');
    // Restore local source before deleting; deletion is offered only for locally held records.
    await list.locator('.proposal-source-btn[data-source="local"]').click();
    await selectNativeOption(list.locator('#proposal-filter-type'), 'all');
    await expect(list.locator('.proposal-list-item')).toHaveCount(3);
    // Fold the filters away again to reach the list rows.
    await list.locator('.proposal-filters-toggle').click();
    await expect(list.locator('#proposal-list-controls')).toBeHidden();
    const target = list.locator(`.proposal-list-item[data-proposal-id="${ids[2]}"]`);
    await target.locator('.proposal-delete-btn').click();
    await expect.poll(() => page.evaluate(id => (window as any).getProposalByIdOrHash(id) == null, ids[2])).toBe(true);
    await expect(list.locator('.proposal-list-item')).toHaveCount(2);
  });

  test('Fork design on the details opens an editable copy that saves as a new design and leaves the source as it was', async ({ mockApi: page }) => {
    await openCity(page);
    await page.locator('#username-display').click();
    await page.locator('#username-input').fill('Fork author');
    await page.locator('#welcome-submit-btn').click();
    const sourceId = await page.evaluate(({ parcelId, geometry }) => (window as any).proposalStorage.addProposal({
      title: 'Original park', goal: 'park', author: 'Ada', lifecycleStatus: 'Active', cadastreParcelIds: [parcelId],
      geometry, structureProposal: { kind: 'park', geometry, applied: true },
    }), { parcelId: PARCEL_ID, geometry: PARCEL_GEOMETRY });
    const sourceBefore = await proposalState(page, sourceId);
    await showProposal(page, sourceId);
    await expandProposalDetails(page);

    await page.locator('.btn-counterpropose-proposal').click();
    const createDialog = page.locator('.create-proposal-modal:visible');
    await expect(createDialog).toBeVisible();
    await expect(createDialog.locator('#proposalName')).toHaveValue('Original park');
    await createDialog.locator('#proposalName').fill('Counterproposal park');
    await createDialog.locator('#proposalDescription').fill('A revised park for the same parcel.');
    await createDialog.locator('input[name="proposalLandUse"][value="park"]').check();
    await createDialog.locator('#createProposalSubmitButton').click();
    await expect(createDialog).toBeHidden({ timeout: 10000 });
    await expect.poll(() => page.evaluate(id => (window as any).proposalStorage.getAllProposals()
      .filter((proposal: any) => proposal.title === 'Counterproposal park' && proposal.proposalId !== id
        && proposal.description === 'A revised park for the same parcel.').length, sourceId)).toBe(1);
    const source = await proposalState(page, sourceId);
    expect(source.title).toBe('Original park');
    expect(source.description).toBe(sourceBefore.description);
  });

  test('a parcel\'s History row loads its ownership and consent timeline', async ({ mockApi: page }) => {
    await page.route(`**/parcels/${encodeURIComponent(PARCEL_ID)}/history`, route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        parcelUid: PARCEL_ID,
        anchor: { account: PROPOSAL_ACCOUNT, exists: null, source: 'unavailable' },
        events: [
          { type: 'proposal_created', at: '2026-08-10T08:00:00Z', title: 'Parcel history proposal' },
          { type: 'proposal_chain_observed', at: '2026-08-10T08:06:00Z', proposalId: 'proposal-42',
            link: `https://explorer.solana.com/address/${PROPOSAL_ACCOUNT}?cluster=devnet` },
          { type: 'proposal_acceptance', at: '2026-08-11T09:00:00Z', proposalId: 'proposal-42', owner: SOLANA_WALLET },
        ],
      }),
    }));
    await openCity(page);
    await openParcel(page);
    // The parcel's Info tab ends with its History, read when the row is opened.
    const history = page.locator(`#parcel-history-section details[data-parcel-history="${PARCEL_ID}"]`);
    await expect(history).toBeVisible();
    await history.locator('summary').click();
    const observation = history.locator('[data-history-type="proposal_chain_observed"]');
    await expect(observation).toContainText('Proposal observed on Solana devnet');
    await expect(observation).toContainText('this is not the mint time');
    await expect(observation.locator('time')).toHaveAttribute('datetime', '2026-08-10T08:06:00Z');
    await expect(observation.getByRole('link', { name: 'View' })).toHaveAttribute('href', /\/address\/.+cluster=devnet/);
    await expect(history.locator('[data-history-type="proposal_acceptance"]')).toContainText('Owner said yes');
    await expect(history.locator('.parcel-history-anchor')).toContainText('Parcel anchor status unavailable');
    await expect(history.locator('.parcel-history-anchor')).not.toContainText('No parcel anchor found');
  });

  test('stacked proposals open the visible side-by-side parcel comparison', async ({ mockApi: page }) => {
    await openCity(page);
    await page.evaluate(({ parcelId, geometry }) => {
      const w = window as any;
      w.proposalStorage.addProposal({ title: 'Compare park plan', goal: 'park', lifecycleStatus: 'Active', cadastreParcelIds: [parcelId], geometry, applied: true });
      w.proposalStorage.addProposal({ title: 'Compare square plan', goal: 'square', lifecycleStatus: 'Active', cadastreParcelIds: [parcelId], geometry, applied: true });
      w.updateProposalLayer();
    }, { parcelId: PARCEL_ID, geometry: PARCEL_GEOMETRY });
    await clickMapPoint(page, 15.9822, 45.80025);

    const stack = page.locator('#drill-stack-panel');
    await expect(stack.locator('.drill-stack-compare')).toBeVisible();
    await stack.locator('.drill-stack-compare').click();
    const comparison = page.locator('#parcel-compare-dialog');
    await expect(comparison).toBeVisible();
    await expect(comparison).toContainText('Compare park plan');
    await expect(comparison).toContainText('Compare square plan');
    await comparison.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(comparison).toBeHidden();
    await stack.locator('.drill-stack-compare').click();
    await expect(comparison).toBeVisible();
    const selectedId = await comparison.locator('.parcel-compare__picker--a select').inputValue();
    await comparison.locator('.parcel-compare__picker--a .parcel-compare__details').click();
    await expect(comparison).toBeHidden();
    await showProposal(page, selectedId);
    await expect(page.locator('#proposal-details-panel')).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).currentlyHighlightedProposalId)).toBe(selectedId);
  });
});
