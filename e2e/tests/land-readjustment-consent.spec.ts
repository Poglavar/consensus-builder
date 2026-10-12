// Purpose: exercise the Land & ownership consent UI when readjustment terms change or are invalid.
import { test, expect } from '../helpers/fixtures';
import { openCity, proposalState, showProposal, PARCEL_ID } from '../helpers/runtime';
import type { Page, TestInfo } from '@playwright/test';

const owners = [
  { name: 'Fixture Owner A', address: 'fixture-owner-a', ownership: '1/2', actualShareText: '50%', percentageShare: 50 },
  { name: 'Fixture Owner B', address: 'fixture-owner-b', ownership: '1/2', actualShareText: '50%', percentageShare: 50 },
];

const ring = [[15.9819, 45.8000], [15.9821, 45.8000], [15.9821, 45.8002], [15.9819, 45.8002], [15.9819, 45.8000]];
const plot = {
  type: 'Polygon',
  coordinates: [ring],
};

async function establishLocalProfile(page: Page): Promise<void> {
  await page.locator('#username-display').click();
  await expect(page.locator('#welcome-modal')).toBeVisible();
  await page.locator('#username-input').fill('Consent Fixture');
  await page.locator('#welcome-submit-btn').click();
  await expect(page.locator('#welcome-modal')).toBeHidden();
}

async function installTestAuthority(page: Page): Promise<string> {
  return page.evaluate(() => {
    const w = window as any;
    const actorId = w.getCurrentUserAgent()?.id;
    if (!actorId) throw new Error('The local profile has no actor ID.');
    const providerId = 'e2e-readjustment-authority';
    if (!w.__lrTestAuthorityInstalled) {
      w.ProposalApprovalAuthorities.register(providerId, {
        authorize({ ownerId, actor, contextHash }: any) {
          if (actor.id !== actorId || ownerId !== 'owner-a') return null;
          return {
            rights: { member: 'e2e-lens', evidenceRef: 'rights-fixture', contextHash },
            authority: { member: 'e2e-lens', evidenceRef: 'authority-fixture', contextHash, ownerId, actorId }
          };
        },
        async signDecision({ statement }: any) {
          const signature = w.__consentSha256.sha256Hex(w.ProposalApproval.stableStringify(statement));
          return { statement: JSON.parse(JSON.stringify(statement)), signature: `e2e:${signature}` };
        },
        verifyReceipt({ statement, receipt }: any) {
          const signature = w.__consentSha256.sha256Hex(w.ProposalApproval.stableStringify(statement));
          return w.ProposalApproval.stableStringify(receipt.decisionProof?.statement) === w.ProposalApproval.stableStringify(statement)
            && receipt.decisionProof?.signature === `e2e:${signature}`;
        }
      });
      w.__lrTestAuthorityInstalled = true;
    }
    return actorId;
  });
}

async function seedReadjustment(page: Page, malformed = false): Promise<string> {
  return page.evaluate(({ parcelId, fakeOwners, geometry, malformedDeal }) => {
    const w = window as any;
    w.ParcelsOwnershipUi.parcelOwnerDataCache.set(parcelId, fakeOwners);
    const slots = w.getParcelOwnerSlots(parcelId);
    if (slots.length !== 2) throw new Error(`Expected two fixture owner slots, found ${slots.length}`);
    // The readjustment allocates to the abstract owners of its rights snapshot, as the editor does.
    const ownerKeys = ['owner-a', 'owner-b'];
    const record: any = {
      title: malformedDeal ? 'Malformed LR consent fixture' : 'LR consent fixture',
      goal: 'reparcellization',
      lifecycleStatus: 'Active',
      funded: false,
      cadastreParcelIds: [parcelId],
      acceptedParcelIds: [],
      ownerAcceptances: {},
      approvalConfig: {
        schema: 'proposal-approval/v1',
        rights: { schema: 'parcel-rights/v1', source: { provider: 'upload', reference: 'lr-consent-fixture' }, parcels: [
          { parcelId, complete: true, areaM2: 100, owners: [
            { ownerId: 'owner-a', share: '1/2' }, { ownerId: 'owner-b', share: '1/2' }
          ] }
        ] },
        policy: { type: 'unanimous' }
      },
      lens: ['e2e-lens'],
      offer: 100,
      offerCurrency: 'EUR',
      isConditional: true,
      reparcellization: {
        poolGeometry: geometry,
        poolSource: 'site',
        contributionBasis: 'area',
        poolUnitValue: 10,
        totalValue: 1000,
        contributionRatio: 1,
        polygons: [{
          geometry,
          jointPool: false,
          owners: [
            { ownerKey: ownerKeys[0], displayName: slots[0].displayName, share: 0.5 },
            { ownerKey: ownerKeys[1], displayName: slots[1].displayName, share: 0.5 },
          ],
        }],
        inputParcels: [{ geometry, ownerKey: ownerKeys[0], displayName: slots[0].displayName }],
        ownerShares: [
          { ownerKey: ownerKeys[0], displayName: slots[0].displayName, cashOffer: 60.12, contributedArea: 50, contributedValue: 500,
            entitledValue: 500, assignedArea: 50, assignedValue: 500, cashBalance: 0 },
          { ownerKey: ownerKeys[1], displayName: slots[1].displayName, cashOffer: 39.88, contributedArea: 50, contributedValue: 500,
            entitledValue: 500, assignedArea: 50, assignedValue: 500, cashBalance: 0 },
        ],
      },
    };
    if (malformedDeal) record.offer = 99; // Deliberately does not equal the EUR 100 owner cash ledger.
    const proposalId = w.proposalStorage.addProposal(record);
    if (!malformedDeal) {
      const saved = w.proposalStorage.getProposal(proposalId);
      const dealHash = w.ReparcellizationDeal.fingerprint(saved);
      const actorId = w.getCurrentUserAgent()?.id;
      const contextHash = w.ProposalApproval.contextHash(saved);
      const receipt: any = {
        ownerId: 'owner-a', actorId, effectHash: dealHash, decision: 'approve',
        acceptedAt: '2026-01-02T03:04:05.000Z', providerId: 'e2e-readjustment-authority',
        evidence: {
          rights: { member: 'e2e-lens', evidenceRef: 'rights-fixture', contextHash },
          authority: { member: 'e2e-lens', evidenceRef: 'authority-fixture', contextHash, ownerId: 'owner-a', actorId }
        }
      };
      const statement = w.ProposalApproval.decisionContent(saved, receipt);
      const signature = w.__consentSha256.sha256Hex(w.ProposalApproval.stableStringify(statement));
      receipt.decisionProof = { statement, signature: `e2e:${signature}` };
      saved.ownerApprovals = { 'owner-a': receipt };
      saved.ownerApprovalHistory = [];
      saved.acceptedParcelIds = [];
      saved.reparcellization.ownerShares[0].cashOffer += 5;
      saved.reparcellization.ownerShares[1].cashOffer -= 5; // Same total; a changed owner allocation.
      w.proposalStorage._indexProposal?.(saved);
      w.proposalStorage.save();
    }
    return proposalId;
  }, { parcelId: PARCEL_ID, fakeOwners: owners, geometry: plot, malformedDeal: malformed });
}

async function openLandSection(page: Page): Promise<void> {
  const land = page.locator('#proposal-details-panel details[data-proposal-section="land"]');
  await expect(land).toBeVisible();
  if (!(await land.evaluate(element => (element as HTMLDetailsElement).open))) {
    await land.locator(':scope > summary').click();
  }
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<string> {
  const screenshotPath = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach(name, { path: screenshotPath, contentType: 'image/png' });
  return screenshotPath;
}

test.beforeEach(async ({ page }) => {
  await page.route(/https:\/\/[^/]*tile\.openstreetmap\.org\//, route => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#eee"/></svg>',
  }));
});

test('changed LR cash terms lapse old consent, then preserve its receipt when an owner reaccepts', async ({ mockApi: page }, testInfo) => {
  await openCity(page);
  await page.evaluate(() => (window as any).i18n.setLanguage('en'));
  await establishLocalProfile(page);
  const actorId = await installTestAuthority(page);
  const proposalId = await seedReadjustment(page);

  const beforeUi = await page.evaluate(id => {
    const w = window as any;
    const record = w.proposalStorage.getProposal(id);
    return {
      originalHash: w.ReparcellizationDeal.fingerprint({
        ...record,
        reparcellization: {
          ...record.reparcellization,
          ownerShares: record.reparcellization.ownerShares.map((owner: any, index: number) => ({
            ...owner, cashOffer: index === 0 ? 60.12 : 39.88,
          })),
        },
      }),
      currentHash: w.ReparcellizationDeal.fingerprint(record),
      summary: w.ProposalApprovalRuntime.summary(record, w.ReparcellizationDeal.fingerprint(record)),
    };
  }, proposalId);
  expect(beforeUi.currentHash).not.toBe(beforeUi.originalHash);
  expect(beforeUi.summary).toMatchObject({ totalOwners: 2, acceptedOwners: 0 });

  await showProposal(page, proposalId);
  const panel = page.locator('#proposal-details-panel');
  const expand = panel.getByRole('button', { name: 'Expand', exact: true });
  if (await expand.isVisible()) await expand.click();
  await openLandSection(page);
  const rows = page.locator('.owner-acceptance-row');
  await expect(rows).toHaveCount(2);
  const cashReview = page.locator('#proposal-details-panel details[data-proposal-section="land"] .readjustment-cash-review');
  await expect(cashReview).toBeVisible();
  const cashRows = cashReview.locator('li');
  await expect(cashRows).toHaveCount(2);
  const ownerACash = cashRows.filter({ hasText: 'Owner A' });
  const ownerBCash = cashRows.filter({ hasText: 'Owner B' });
  await expect(ownerACash).toContainText('65.12');
  await expect(ownerBCash).toContainText('34.88');
  await expect(cashReview.locator('.readjustment-cash-review-total')).toContainText('100.00');
  await expect(rows.locator('.owner-payout')).toHaveCount(0);
  const firstRow = page.locator('.owner-acceptance-row[data-owner-key="owner-a"]');
  await expect(firstRow).toHaveAttribute('data-owner-key', 'owner-a');
  await expect(firstRow.locator('.owner-acceptance-changed')).toContainText('Terms changed');
  await expect(firstRow.getByRole('button', { name: 'Accept', exact: true })).toBeEnabled();
  await firstRow.scrollIntoViewIfNeeded();
  await attachScreenshot(page, testInfo, 'lr-consent-desktop');

  const ownerKey = await firstRow.getAttribute('data-owner-key');
  expect(ownerKey).toBeTruthy();
  await firstRow.getByRole('button', { name: 'Accept', exact: true }).click();
  // Accept opens the owner's review; only its own Accept asks for the signature.
  const review = page.locator('#proposal-approval-dialog .cb-dialog');
  await expect(review).toHaveAttribute('data-approval-review', 'owner-a');
  await expect(review.locator('[data-approval-cash]')).toContainText('65.12');
  expect((await proposalState(page, proposalId)).ownerApprovals['owner-a']?.effectHash).toBe(beforeUi.originalHash);
  await review.locator('[data-approval-accept="owner-a"]').click();
  await expect(review).toHaveAttribute('data-approval-receipt', 'owner-a');
  await review.locator('.cb-dialog__footer').getByRole('button', { name: 'Done', exact: true }).click();
  await expect.poll(async () => (await proposalState(page, proposalId)).ownerApprovals['owner-a']?.effectHash)
    .toBe(beforeUi.currentHash);
  const accepted = await proposalState(page, proposalId);
  expect(accepted.ownerApprovalHistory).toHaveLength(1);
  expect(accepted.ownerApprovalHistory[0]).toMatchObject({ ownerId: 'owner-a', effectHash: beforeUi.originalHash });
  expect(accepted.ownerApprovals['owner-a']).toMatchObject({ ownerId: 'owner-a', actorId, effectHash: beforeUi.currentHash, decision: 'approve' });
  expect(accepted.ownerApprovals['owner-a'].decisionProof.signature).toMatch(/^e2e:/);
  expect(accepted.acceptedParcelIds).not.toContain(PARCEL_ID); // The other owner's stale receipt is not current consent.
  expect(accepted.funded).toBe(false);
  expect(accepted.onchain).toBeFalsy();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window as any).proposalStorage && !!(window as any).ReparcellizationDeal);
  await installTestAuthority(page);
  // Only proposal consent is persisted by this fixture; reseeding owners does not test source-owner persistence.
  await page.evaluate(({ parcelId, fakeOwners }) => {
    (window as any).ParcelsOwnershipUi.parcelOwnerDataCache.set(parcelId, fakeOwners);
  }, { parcelId: PARCEL_ID, fakeOwners: owners });
  await showProposal(page, proposalId);
  const mobilePanel = page.locator('#proposal-details-panel');
  const mobileExpand = mobilePanel.getByRole('button', { name: 'Expand', exact: true });
  if (await mobileExpand.isVisible()) await mobileExpand.click();
  await openLandSection(page);
  await expect(page.locator('#proposal-details-panel details[data-proposal-section="land"] .owner-acceptance-row')).toHaveCount(2);
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(mobileOverflow, '390px viewport must not scroll horizontally').toBe(false);
  const mobileLand = page.locator('#proposal-details-panel details[data-proposal-section="land"]');
  const mobileAcceptButtons = mobileLand.getByRole('button', { name: 'Accept', exact: true });
  for (let index = 0; index < await mobileAcceptButtons.count(); index += 1) {
    const rect = await mobileAcceptButtons.nth(index).boundingBox();
    expect(rect, 'mobile Accept control must be rendered').not.toBeNull();
    expect(rect!.x).toBeGreaterThanOrEqual(0);
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(390);
  }
  if (await mobileAcceptButtons.count()) await mobileAcceptButtons.first().scrollIntoViewIfNeeded();
  await attachScreenshot(page, testInfo, 'lr-consent-mobile-390');
  const afterReload = await page.evaluate(id => {
    const w = window as any;
    const record = w.proposalStorage.getProposal(id);
    return {
      viewport: { width: innerWidth, height: innerHeight },
      summary: w.ProposalApprovalRuntime.summary(record, w.ReparcellizationDeal.fingerprint(record)),
      record: JSON.parse(JSON.stringify(record)),
    };
  }, proposalId);
  expect(afterReload.viewport.width).toBe(390);
  expect(afterReload.summary).toMatchObject({ totalOwners: 2, acceptedOwners: 1 });
  expect(afterReload.record.ownerApprovals['owner-a']).toMatchObject({ ownerId: 'owner-a', actorId, effectHash: beforeUi.currentHash });
  expect(afterReload.record.ownerApprovals['owner-b']).toBeUndefined();
  await expect(mobileLand.locator('[data-owner-key="owner-b"] button')).toHaveCount(0);
});

test('invalid LR cash allocation cannot record an acceptance', async ({ mockApi: page }, testInfo) => {
  await openCity(page);
  await page.evaluate(() => (window as any).i18n.setLanguage('en'));
  await establishLocalProfile(page);
  await installTestAuthority(page);
  const proposalId = await seedReadjustment(page, true);
  await showProposal(page, proposalId);
  const panel = page.locator('#proposal-details-panel');
  const expand = panel.getByRole('button', { name: 'Expand', exact: true });
  if (await expand.isVisible()) await expand.click();
  await openLandSection(page);
  const row = page.locator('.owner-acceptance-row[data-owner-key="owner-a"]');
  await expect(row).toBeVisible();
  await expect(row.getByRole('button', { name: 'Accept', exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  const land = page.locator('#proposal-details-panel details[data-proposal-section="land"]');
  const invalidReview = land.locator('.readjustment-cash-review-invalid');
  await expect(invalidReview).toBeVisible();
  await expect(invalidReview).toContainText('Correct the readjustment allocations and cash terms before accepting.');
  await invalidReview.scrollIntoViewIfNeeded();
  await attachScreenshot(page, testInfo, 'lr-consent-invalid-review-mobile-390');
  // Invalid terms intentionally offer no Accept button. Call the public action handler directly
  // to exercise its invalid-terms guard before it reaches a signer or wallet.
  await page.evaluate(({ proposalId, parcelId }) => (window as any).acceptProposalFromParcelInfo(proposalId, parcelId, 'owner-a'),
    { proposalId, parcelId: PARCEL_ID });
  const invalidTermsNotice = page.getByRole('alertdialog');
  await expect(invalidTermsNotice).toContainText('Complete and correct the readjustment allocations and cash terms before accepting.');
  await attachScreenshot(page, testInfo, 'lr-consent-invalid-notice-mobile-390');
  const noticeBounds = await invalidTermsNotice.boundingBox();
  expect(noticeBounds).not.toBeNull();
  expect(noticeBounds!.x).toBeGreaterThanOrEqual(0);
  expect(noticeBounds!.x + noticeBounds!.width).toBeLessThanOrEqual(390);
  expect(noticeBounds!.y).toBeGreaterThanOrEqual(0);
  expect(noticeBounds!.y + noticeBounds!.height).toBeLessThanOrEqual(844);
  await invalidTermsNotice.getByRole('button', { name: 'OK', exact: true }).click();
  const invalid = await proposalState(page, proposalId);
  expect(invalid.ownerApprovals || {}).toEqual({});
  expect(invalid.ownerApprovalHistory || []).toEqual([]);
  expect(invalid.acceptedParcelIds).not.toContain(PARCEL_ID);
  expect(invalid.funded).toBe(false);
  expect(invalid.onchain).toBeFalsy();
});
