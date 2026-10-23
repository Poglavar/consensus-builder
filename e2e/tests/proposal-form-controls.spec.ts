import { openDesignReview } from '../helpers/design-review';
// Purpose: verify proposal metadata (ownership, epoch, tolerance) and list filters through their forms.
import { test, expect } from '../helpers/fixtures';
import { selectNativeOption } from '../helpers/controls';
import { createSpace, openCity, PARCEL_ID, showProposal } from '../helpers/runtime';

test('ownership, epoch and parcel tolerance persist from the draft review form', async ({ mockApi: page }) => {
  await openCity(page);
  const sourceId = await createSpace(page, 'park');
  await showProposal(page, sourceId);
  const panel = page.locator('#proposal-details-panel');
  const expand = panel.getByRole('button', { name: 'Expand', exact: true });
  if (await expand.isVisible()) await expand.click();
  const more = panel.locator('summary').filter({ hasText: 'More actions' });
  if (await more.isVisible()) await more.click();
  await openDesignReview(page, sourceId);
  const form = page.locator('.create-proposal-modal:visible');
  await expect(form).toBeVisible();
  const areaSummary = form.locator('#proposalSummaryContent p').filter({ hasText: 'Total area:' });
  await expect(areaSummary).toContainText(/[1-9][\d,.\s\u202f]*m²/);
  await form.locator('#proposalName').fill('Detailed inherited park title');
  await form.locator('#proposalDescription').fill('Keep these authored design details when ownership changes.');
  for (const ownership of ['to-me', 'to-city', 'no-change']) {
    await form.locator(`input[name="proposalOwnership"][value="${ownership}"]`).locator('..').click();
    await expect.poll(() => page.evaluate(() => (window as any).proposalFacets?.ownership)).toBe(ownership);
    await expect(form.locator('#proposalName')).toHaveValue('Detailed inherited park title');
    await expect(form.locator('#proposalDescription')).toHaveValue('Keep these authored design details when ownership changes.');
  }
  await expect(form.locator('input[name="proposalParcelsMode"][value="as-is"]')).toBeChecked();
  // A design carries no terms and no decision kind: who decides is the agreement's rule (M2).
  await expect(form.locator('input[name="proposalKind"]')).toHaveCount(0);
  await form.locator('#proposalName').fill('A park for 2035');
  await selectNativeOption(form.locator('#proposalEpochYear'), '2035');
  if (!(await form.locator('#proposalOptionsContent').isVisible())) {
    await form.locator('#proposalOptionsSection > .collapsible-header').click();
  }
  await form.locator('#proposalToleranceM').fill('0.12');
  await form.locator('#proposalToleranceM').press('Tab');
  await form.locator('#createProposalSubmitButton').click();
  await expect(form).toBeHidden();
  const saved = await page.evaluate(() => (window as any).proposalStorage.getAllProposals()
    .find((proposal: any) => proposal.title === 'A park for 2035'));
  expect(saved).toMatchObject({ epochYear: 2035, toleranceM: 0.12 });
  expect(saved.proposalOrigin).toBeFalsy();
  for (const term of ['kind', 'offer', 'voteExpiryDays', 'expiresAt', 'isVote']) expect(saved).not.toHaveProperty(term);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(id => (window as any).proposalStorage?.getProposal(id)?.epochYear, saved.proposalId)).toBe(2035);
  const restored = await page.evaluate(id => (window as any).proposalStorage.getProposal(id), saved.proposalId);
  expect(restored).toMatchObject({ epochYear: 2035, toleranceM: 0.12 });
});

test('publication and search filters narrow the design list by title and author', async ({ mockApi: page }) => {
  await openCity(page);
  await page.evaluate(parcelId => {
    const rows = [
      { title: 'Neighbourhood park', author: 'Alex', lifecycleStatus: 'Active', applied: true },
      { title: 'Unapplied active park', author: 'Blair', lifecycleStatus: 'Active', applied: false },
      { title: 'Published park', author: 'Alex', applied: false },
    ];
    const w = window as any;
    const ids = rows.map(row => w.proposalStorage.addProposal({ ...row, goal: 'park', cadastreParcelIds: [parcelId] }));
    const published = w.proposalStorage.getProposal(ids[2]);
    w.DesignSync.markPublished(published, { cid: w.DesignRecord.cidOf(published), apiBase: w.resolveBackendBaseUrl(), publishedAt: '2026-10-01T00:00:00.000Z' });
  }, PARCEL_ID);
  await page.locator('#proposals-button').click();
  const list = page.locator('#proposals-sheet .proposal-list-modal');
  const titles = list.locator('.proposal-list-title');
  await expect(titles).toHaveCount(3);
  await list.locator('.proposal-filters-toggle').click();
  await expect(list.locator('#proposal-filter-applied')).toHaveCount(0);
  await expect(list.locator('#proposal-filter-author')).toHaveCount(0);
  await expect(list.locator('.proposal-filters-toggle-count')).toHaveCount(0);
  await expect(list.locator('#agreementsButton, #mintedAgreementsButton')).toHaveCount(0);
  await selectNativeOption(list.locator('#proposal-filter-publication'), 'draft');
  await expect(titles).toHaveCount(2);
  await list.locator('#proposal-filter-search').fill('Neighbourhood');
  await expect(titles).toHaveText(['Neighbourhood park']);
  await list.locator('#proposal-filter-search').fill('Blair');
  await expect(titles).toHaveText(['Unapplied active park']);
  await list.locator('#proposal-filter-search').fill('');
  await selectNativeOption(list.locator('#proposal-filter-publication'), 'all');
  await list.locator('#proposal-filter-search').fill('Alex');
  await expect(titles).toHaveCount(2);
  await expect(titles).not.toContainText(['Unapplied active park']);
  await selectNativeOption(list.locator('#proposal-filter-publication'), 'published');
  await expect(titles).toHaveText(['Published park']);
  await list.locator('#proposal-filter-search').fill('Blair');
  await expect(titles).toHaveCount(0);
  await list.locator('#proposal-filter-search').fill('');
  await selectNativeOption(list.locator('#proposal-filter-publication'), 'all');
  await expect(titles).toHaveCount(3);
});
