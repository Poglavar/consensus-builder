// Verify walk-upload, drill-stack and ownership-transfer dialog actions.
import { test, expect } from '../helpers/fixtures';
import { clickMapPoint, openCity, PARCEL_GEOMETRY, PARCEL_ID } from '../helpers/runtime';
import { sampleParcels } from '../helpers/mocks/parcel-data';
import { attachSharedProposalServer, createSharedProposalServer } from '../helpers/mocks/shared-server';

const SECOND_PARCEL_ID = sampleParcels.features[1].properties.parcelId;

async function establishLocalProfile(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('#username-display').click();
  await expect(page.locator('#welcome-modal')).toBeVisible();
  await page.locator('#username-input').fill('Proposal follow-up tester');
  await page.locator('#welcome-submit-btn').click();
  await expect(page.locator('#welcome-modal')).toBeHidden();
}

test.describe('proposal button controls follow-up @features', () => {
  test('walk upload gate supports one-row upload followed by Upload all', async ({ mockApi: page }) => {
    const server = createSharedProposalServer();
    await attachSharedProposalServer(page, server);
    await openCity(page);
    await establishLocalProfile(page);
    const proposalIds = await page.evaluate(({ parcelId, geometry }) => {
      const storage = (window as any).proposalStorage;
      return [1, 2, 3].map(index => storage.addProposal({
        proposalId: `walk-upload-${index}`,
        title: `Walk upload ${index}`,
        goal: 'park',
        lifecycleStatus: 'Active',
        applied: true,
        cadastreParcelIds: [parcelId],
        geometry,
        structureProposal: { kind: 'park', geometry, applied: true },
      }));
    }, { parcelId: PARCEL_ID, geometry: PARCEL_GEOMETRY });

    await page.evaluate(() => (window as any).showWalkUploadGateModal({}));

    const modal = page.locator('.share-modal-overlay');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Upload before walking');
    const rowUploads = modal.getByRole('button', { name: 'Upload', exact: true });
    await expect(rowUploads).toHaveCount(3);
    await rowUploads.first().click();
    await expect(modal.getByRole('button', { name: 'Uploaded', exact: true })).toHaveCount(1);
    await expect.poll(() => server.records.size).toBe(1);
    await modal.getByRole('button', { name: 'Upload all', exact: true }).click();
    await expect(modal).toBeHidden();
    await expect.poll(() => server.records.size).toBe(3);
    expect([...server.records.values()].map(record => record.title).sort()).toEqual([
      'Walk upload 1', 'Walk upload 2', 'Walk upload 3',
    ]);
    expect(await page.evaluate(ids => ids.every(id => {
      const proposal = (window as any).proposalStorage.getProposal(id);
      return Boolean(proposal?.serverProposalId);
    }), proposalIds)).toBe(true);
  });

  test('drill stack lets the user switch base parcel and proposal, then close the stack', async ({ mockApi: page }) => {
    await openCity(page);
    await establishLocalProfile(page);
    await page.evaluate(async parcelId => {
      await (window as any).CadastralParcelRepository.ensureIds([parcelId]);
    }, SECOND_PARCEL_ID);
    await page.evaluate(({ parcelIds, geometry }) => {
      const storage = (window as any).proposalStorage;
      // Both proposals cover either base parcel. The drill stack is re-evaluated when the
      // selected parcel changes, so a footprint limited to the first parcel would disappear
      // before the user can select the proposal row.
      const footprint = {
        type: 'MultiPolygon',
        coordinates: [geometry.coordinates, (window as any).CadastralParcelRepository.get(parcelIds[1]).geometry.coordinates],
      };
      for (const [index, goal] of ['park', 'square'].entries()) {
        storage.addProposal({
          proposalId: `drill-stack-${index}`,
          title: `Drill stack ${goal}`,
          goal,
          lifecycleStatus: 'Active',
          applied: true,
          cadastreParcelIds: parcelIds,
          geometry: footprint,
          structureProposal: { kind: goal, geometry: footprint, applied: true },
        });
      }
      (window as any).updateProposalLayer();
    }, { parcelIds: [PARCEL_ID, SECOND_PARCEL_ID], geometry: PARCEL_GEOMETRY });
    await clickMapPoint(page, 15.9822, 45.80025);

    const stack = page.locator('#drill-stack-panel');
    await expect(stack).toBeVisible();
    const parcelRows = stack.locator('.drill-stack-parcel-btn');
    await expect(parcelRows).toHaveCount(2);
    await parcelRows.nth(1).click();
    await expect(parcelRows.nth(1)).toHaveAttribute('aria-pressed', 'true');

    // Opening the chosen base parcel dismisses the current stack. Click that parcel's authored
    // footprint to open its own stack before choosing the proposal level.
    await clickMapPoint(page, 15.9829, 45.80025);
    await expect(stack).toBeVisible();
    const proposalRow = stack.locator('.drill-stack-row[data-ref^="p:"]').first();
    await expect(proposalRow).toBeVisible();
    await proposalRow.click();
    await expect(proposalRow).toHaveAttribute('aria-pressed', 'true');
    await stack.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(stack).toBeHidden();
  });

  test('seller offer explains unavailable funding without a fake transfer action', async ({ mockApi: page }) => {
    await openCity(page);
    await establishLocalProfile(page);
    const proposalId = await page.evaluate(({ parcelId, geometry }) => (window as any).proposalStorage.addProposal({
      title: 'Ownership transfer request',
      goal: 'ownership-transfer-from-me',
      lifecycleStatus: 'Active',
      offer: 100, offerCurrency: 'EUR', funded: false,
      cadastreParcelIds: [parcelId],
      geometry,
      ownershipTransferProposal: { direction: 'from-me', recipientScope: 'any', status: 'open' },
    }), { parcelId: PARCEL_ID, geometry: PARCEL_GEOMETRY });
    await page.evaluate(() => (window as any).i18n.setLanguage('en'));
    await page.evaluate(id => (window as any).showProposalDetails(id), proposalId);
    const panel = page.locator('#proposal-details-panel');
    const expand = panel.getByRole('button', { name: 'Expand', exact: true });
    if (await expand.isVisible()) await expand.click();
    const funding = page.locator('#proposal-details-content details[data-proposal-section="funding"]');
    if (!(await funding.evaluate(element => (element as HTMLDetailsElement).open))) {
      await funding.locator(':scope > summary').click();
    }
    await expect(funding).toHaveJSProperty('open', true);
    await expect(funding.locator('.proposal-offer-funding-note')).toHaveText('Funding this offer is not available here.');
    await expect(funding.locator('.offer-amount')).toHaveText('€100');
    await expect(funding.locator('.proposal-no-deposit-warning')).toHaveText('⚠️ No deposit specified');
    await expect(funding.getByRole('button', { name: 'Accept ownership transfer', exact: true })).toHaveCount(0);
    await expect(page.locator('#acceptOwnershipTransferOverlay')).toHaveCount(0);
    await expect(panel.locator('.proposal-buy-btn')).toHaveText('Simulate purchase');
  });
});
