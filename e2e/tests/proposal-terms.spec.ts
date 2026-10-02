import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, createSpace, proposalState, showProposal, PARCEL_GEOMETRY, PARCEL_ID } from '../helpers/runtime';

test.describe('Proposal terms @features', () => {
  test('fork persists changed ownership recipient and advanced payment terms', async ({ mockApi: page }) => {
    await openCity(page);
    const sourceId = await createSpace(page, 'park');
    await showProposal(page, sourceId);
    const expand = page.locator('#proposal-details-panel').getByRole('button', { name: 'Expand', exact: true });
    if (await expand.isVisible()) await expand.click();
    await page.locator('.btn-counterpropose-proposal').click();

    const dialog = page.locator('.create-proposal-modal:visible');
    await expect(dialog).toBeVisible();
    await dialog.locator('.proposal-radio').filter({ hasText: /^Third party$/ }).click();
    await dialog.locator('input[name="proposalRecipientScope"][value="specific"]').locator('..').click();
    await dialog.locator('#proposalRecipientAddress').fill('0x1234567890abcdef1234567890abcdef12345678');
    const optionsHeader = dialog.locator('#proposalOptionsSection > .collapsible-header');
    if (!await dialog.locator('#proposalOffer').isVisible()) await optionsHeader.click();
    await expect(dialog.locator('#proposalOptionsContent')).toBeVisible();
    await dialog.locator('#proposalOffer').fill('1000');
    await dialog.locator('#proposalExpireCheckbox').check();
    await dialog.locator('#proposalExpiryTime').fill('01h:00m:00s');
    await dialog.locator('#proposalConditionalCheckbox').uncheck();
    await dialog.locator('#proposalDecayCheckbox').check();
    await dialog.locator('#proposalDecayPercent').fill('25');
    await dialog.locator('#proposalDecayTime').fill('02h:00m:00s');
    await dialog.locator('#proposalDepositCheckbox').check();
    await dialog.locator('#proposalDepositPercent').fill('40');

    await dialog.locator('#proposalName').fill('Terms changed through the proposal UI');
    await dialog.locator('#proposalDescription').fill('A fork with explicit recipient and payment terms.');
    await dialog.locator('#createProposalSubmitButton').click();

    await expect(dialog).toBeHidden({ timeout: 10000 });
    const saved = await page.evaluate(() => {
      const proposal = (window as any).proposalStorage.getAllProposals()
        .find((item: any) => item.title === 'Terms changed through the proposal UI');
      return proposal ? JSON.parse(JSON.stringify(proposal)) : null;
    });
    expect(saved).toBeTruthy();
    expect(saved.copiedFromProposalId).toBe(sourceId);
    expect(saved.cadastreParcelIds).toContain(PARCEL_ID);
    expect(saved.isConditional).toBe(false);
    expect(saved.disbursementMode).toBe('partial');
    expect(saved.expiresAt).toBeTruthy();
    expect(new Date(saved.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(saved.decayEnabled).toBe(true);
    expect(saved.decayPercent).toBe(25);
    expect(saved.decayDurationMs).toBe(2 * 60 * 60 * 1000);
    expect(saved.depositEnabled).toBe(true);
    expect(saved.depositPercent).toBe(40);
    expect(saved.facets).toMatchObject({ ownership: 'third-party' });
    expect(saved.ownershipTransferProposal).toMatchObject({
      recipientScope: 'specific', recipientAddress: '0x1234567890abcdef1234567890abcdef12345678',
    });
    expect((await proposalState(page, sourceId)).title).not.toBe(saved.title);
  });

  test('readjusting parcel boundaries locks ownership to per-replacement-parcel in the terms UI', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-build-btn--reparcellization').click();
    const reparcel = page.locator('.reparcel-modal-overlay');
    await expect(reparcel).toBeVisible();
    await expect(reparcel.locator('[data-reparcel-newplots-table]')).not.toBeEmpty();
    await reparcel.locator('[data-reparcel-commit]').click();
    await expect(reparcel).toBeHidden();
    const sourceId = await page.evaluate(() => {
      const proposal = (window as any).proposalStorage.getAllProposals()
        .find((item: any) => item.applied && item.reparcellization?.polygons?.length);
      if (!proposal) throw new Error('The committed readjustment proposal was not saved');
      return proposal.proposalId;
    });
    await showProposal(page, sourceId);
    const expand = page.locator('#proposal-details-panel').getByRole('button', { name: 'Expand', exact: true });
    if (await expand.isVisible()) await expand.click();
    await page.locator('.btn-counterpropose-proposal').click();

    const dialog = page.locator('.create-proposal-modal:visible');
    await expect(dialog).toBeVisible();
    const readjust = dialog.locator('input[name="proposalParcelsMode"][value="readjust"]');
    await expect(readjust).toBeChecked();
    await expect(readjust).toBeDisabled();
    const perSlice = dialog.locator('input[name="proposalOwnership"][value="per-slice"]');
    await expect(perSlice).toBeChecked();
    await expect(dialog.locator('#proposalOwnershipGroup')).toBeHidden();
    await expect(dialog.locator('#proposalOwnershipStatic')).toContainText(/Per slice/i);
  });
});
