// The agreement panel says nothing about the map while the agreement matches it; taking a design off
// the map shows one warning naming why, and its Apply plan designs button puts the design back.
import { test, expect } from '../helpers/fixtures';
import { openCity } from '../helpers/runtime';
import { agreementPanel, openAgreementDecision, panelStatus, proposeOverPark } from '../helpers/agreements';

test('an agreement warns only when it does not match the map, and Apply plan designs restores it', async ({ mockApi: page }) => {
  test.setTimeout(120_000);
  await openCity(page);
  const { id, parkId, parkTitle } = await proposeOverPark(page, { title: 'Park agreement', author: 'Warning fixture' });
  const isApplied = () => page.evaluate(proposalId => (window as any).getProposalByIdOrHash(proposalId).applied === true, parkId);
  await page.evaluate(agreementId => (window as any).AgreementPanel.open(agreementId), id);
  const panel = agreementPanel(page);
  await panelStatus(page, 'current');
  await expect(panel.locator('[data-agreement-action="compare"]')).toBeEnabled();

  await page.evaluate(async proposalId => { await (window as any).ProposalManager.unapplyProposal(proposalId, { silent: true, suppressCameraMove: true }); }, parkId);
  expect(await isApplied()).toBe(false);
  await openAgreementDecision(page);
  const warning = await panelStatus(page, 'stale');
  const visibleWarning = panel.locator('[data-agreement-status]');
  await expect(visibleWarning.locator('.agreement-panel-status-text'))
    .toHaveText(`Does not match the map: a design is not applied (${parkTitle}). Before / after needs it to match.`);
  await expect(panel.locator('[data-agreement-action="compare"]')).toBeDisabled();

  await visibleWarning.locator('[data-agreement-action="apply-designs"]').click();
  await expect.poll(isApplied, { timeout: 30_000 }).toBe(true);
  await panelStatus(page, 'current');
  await expect(panel.locator('[data-agreement-action="compare"]')).toBeEnabled();
});
