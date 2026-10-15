// Purpose: verify previously unexercised proposal metadata and list filters through their forms.
import { test, expect } from '../helpers/fixtures';
import { selectNativeOption } from '../helpers/controls';
import { createSpace, openCity, PARCEL_ID, showProposal } from '../helpers/runtime';

test('epoch, voting period and parcel tolerance persist from the proposal terms form', async ({ mockApi: page }) => {
  await openCity(page);
  const sourceId = await createSpace(page, 'park');
  await showProposal(page, sourceId);
  const panel = page.locator('#proposal-details-panel');
  const expand = panel.getByRole('button', { name: 'Expand', exact: true });
  if (await expand.isVisible()) await expand.click();
  const more = panel.locator('summary').filter({ hasText: 'More actions' });
  if (await more.isVisible()) await more.click();
  await panel.locator('.btn-counterpropose-proposal').click();
  const form = page.locator('.create-proposal-modal:visible');
  await expect(form).toBeVisible();
  for (const ownership of ['to-me', 'to-city', 'no-change']) {
    await form.locator(`input[name="proposalOwnership"][value="${ownership}"]`).locator('..').click();
    await expect.poll(() => page.evaluate(() => (window as any).proposalFacets?.ownership)).toBe(ownership);
  }
  await expect(form.locator('input[name="proposalParcelsMode"][value="as-is"]')).toBeChecked();
  await form.locator('#proposalName').fill('A thirty-day park vote for 2035');
  await selectNativeOption(form.locator('#proposalEpochYear'), '2035');
  if (!(await form.locator('#proposalOptionsContent').isVisible())) {
    await form.locator('#proposalOptionsSection > .collapsible-header').click();
  }
  await expect(form.locator('#proposalVoteExpiryDays')).toBeVisible();
  await form.locator('#proposalVoteExpiryDays').fill('30');
  await form.locator('#proposalToleranceM').fill('0.12');
  await form.locator('#proposalToleranceM').press('Tab');
  const earliestExpiry = Date.now() + 30 * 86_400_000;
  await form.locator('#createProposalSubmitButton').click();
  await expect(form).toBeHidden();
  const saved = await page.evaluate(() => (window as any).proposalStorage.getAllProposals()
    .find((proposal: any) => proposal.title === 'A thirty-day park vote for 2035'));
  expect(saved).toMatchObject({ copiedFromProposalId: sourceId, epochYear: 2035, isVote: true, voteExpiryDays: 30, toleranceM: 0.12 });
  expect(new Date(saved.expiresAt).getTime()).toBeGreaterThanOrEqual(earliestExpiry);
  expect(new Date(saved.expiresAt).getTime()).toBeLessThan(Date.now() + 30 * 86_400_000 + 1000);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(id => (window as any).proposalStorage?.getProposal(id)?.epochYear, saved.proposalId)).toBe(2035);
  const restored = await page.evaluate(id => (window as any).proposalStorage.getProposal(id), saved.proposalId);
  expect(restored).toMatchObject({ voteExpiryDays: 30, toleranceM: 0.12, expiresAt: saved.expiresAt });
});

test('lifecycle, applied-state and author filters narrow the actual proposal list', async ({ mockApi: page }) => {
  await openCity(page);
  await page.evaluate(parcelId => {
    const rows = [
      { title: 'Applied active park', author: 'Alex', lifecycleStatus: 'Active', applied: true },
      { title: 'Unapplied active park', author: 'Blair', lifecycleStatus: 'Active', applied: false },
      { title: 'Executed park', author: 'Alex', lifecycleStatus: 'Executed', applied: false },
    ];
    rows.forEach(row => (window as any).proposalStorage.addProposal({ ...row, goal: 'park', cadastreParcelIds: [parcelId] }));
  }, PARCEL_ID);
  await page.locator('#proposals-button').click();
  const list = page.locator('#proposals-sheet .proposal-list-modal');
  const titles = list.locator('.proposal-list-title');
  await expect(titles).toHaveCount(3);
  await list.locator('.proposal-filters-toggle').click();
  await selectNativeOption(list.locator('#proposal-filter-lifecycle'), 'active');
  await expect(titles).toHaveCount(2);
  await selectNativeOption(list.locator('#proposal-filter-applied'), 'applied');
  await expect(titles).toHaveText(['Applied active park']);
  await selectNativeOption(list.locator('#proposal-filter-applied'), 'not-applied');
  await expect(titles).toHaveText(['Unapplied active park']);
  await selectNativeOption(list.locator('#proposal-filter-applied'), 'all');
  await selectNativeOption(list.locator('#proposal-filter-lifecycle'), 'all');
  await list.locator('#proposal-filter-author').fill('Alex');
  await expect(titles).toHaveCount(2);
  await expect(titles).not.toContainText(['Unapplied active park']);
  await selectNativeOption(list.locator('#proposal-filter-lifecycle'), 'executed');
  await expect(titles).toHaveText(['Executed park']);
  await list.locator('#proposal-filter-author').fill('Blair');
  await expect(titles).toHaveCount(0);
  await list.locator('#proposal-filter-author').fill('');
  await selectNativeOption(list.locator('#proposal-filter-lifecycle'), 'all');
  await expect(titles).toHaveCount(3);
});
