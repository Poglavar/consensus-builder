import { Browser, BrowserContext, Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { openCity, openParcel, createSpace, proposalState, showProposal, PARCEL_ID } from '../helpers/runtime';
import { sampleParcels } from '../helpers/mocks/parcel-data';
import { mockAllApiRoutes } from '../helpers/mocks/api-routes';
import { attachSharedProposalServer, createSharedProposalServer } from '../helpers/mocks/shared-server';

async function personalizeProfile(page: Page, name: string): Promise<void> {
  await page.locator('#username-display').click();
  await expect(page.locator('#welcome-modal')).toBeVisible();
  await page.locator('#username-input').fill(name);
  await page.locator('#welcome-submit-btn').click();
  await expect(page.locator('#welcome-modal')).toBeHidden();
  await expect(page.locator('#username-text')).toHaveText(name);
  await expect.poll(() => page.evaluate(() => {
    const w = window as any;
    return w.GuestPolicy.check('share', { isGuest: w.getCurrentUserAgent?.()?.isGuest }).allowed;
  })).toBe(true);
}

async function receivingDevice(
  browser: Browser,
  shareUrl: string,
  server: ReturnType<typeof createSharedProposalServer>
): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:8080' });
  await context.addInitScript(() => {
    try {
      localStorage.setItem('cb_current_city', 'new_york');
      localStorage.setItem('cb_site_intro_seen_v1', '1');
    } catch (_) { /* opaque origin */ }
  });
  const page = await context.newPage();
  await mockAllApiRoutes(page);
  await attachSharedProposalServer(page, server);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(shareUrl);
  await waitForMapReady(page);
  return { context, page, errors };
}

async function expectAppliedOnFabric(page: Page, proposalId: string): Promise<void> {
  await expect.poll(async () => {
    const state = await proposalState(page, proposalId);
    return !!state?.applied;
  }, { timeout: 60_000 }).toBe(true);
  await expect.poll(() => page.evaluate((id) => {
    const w = window as any;
    const proposal = w.getProposalByIdOrHash(id);
    const fabric = w.LiveParcelFabric;
    if (!proposal || !fabric?.producedBy || !fabric?.featureId || !w.ParcelPresenter?.getLayer) return false;
    const produced = fabric.producedBy(String(proposal.proposalId));
    return produced.length > 0 && produced.some((feature: any) => {
      const featureId = fabric.featureId(feature);
      return !!featureId && !!w.ParcelPresenter.getLayer(String(featureId));
    });
  }, proposalId), { timeout: 30_000 }).toBe(true);
}

test.describe('Proposal sharing @core', () => {
  test('individual share UI publishes an applied proposal that imports and replays on another device', async ({ mockApi: sender, browser }) => {
    const server = createSharedProposalServer();
    await attachSharedProposalServer(sender, server);
    await openCity(sender);
    await personalizeProfile(sender, 'Share author');
    const proposalId = await createSpace(sender, 'park');
    const beforeShare = await proposalState(sender, proposalId);
    expect(beforeShare.applied).toBe(true);

    await showProposal(sender, proposalId);
    await sender.locator('.btn-share-proposal').click();
    const downloadPromise = sender.waitForEvent('download');
    await sender.locator('.share-modal-overlay').getByRole('button', { name: 'Download', exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^proposal-.*\.json$/);
    await sender.locator('.share-modal-overlay').getByRole('button', { name: 'Upload', exact: true }).click();
    const shareLink = sender.locator('.share-modal-overlay .share-modal-link').first();
    await expect(shareLink).toHaveValue(/\/proposals\/\d+\?/);
    const shareUrl = await shareLink.inputValue();
    expect(server.records.size).toBe(1);
    const publishedRecord = server.records.values().next().value;
    if (!publishedRecord) throw new Error('The publish API did not persist a proposal record.');
    expect(publishedRecord).toMatchObject({ goal: 'park' });
    expect(String(publishedRecord.proposalId)).toMatch(/^c2-/);
    expect(publishedRecord.proposalId).not.toBe(proposalId);
    expect(publishedRecord).not.toHaveProperty('applied');
    const publishedProposalId = String(publishedRecord.proposalId);

    const receiver = await receivingDevice(browser, shareUrl, server);
    try {
      await expectAppliedOnFabric(receiver.page, publishedProposalId);
      const state = await proposalState(receiver.page, publishedProposalId);
      expect(state.applied).toBe(true);
      await receiver.page.reload();
      await waitForMapReady(receiver.page);
      await expectAppliedOnFabric(receiver.page, publishedProposalId);
      const afterReload = await receiver.page.evaluate((id) => {
        const w = window as any;
        return w.proposalStorage.getAllProposals().filter((p: any) => p.proposalId === id && p.applied).length;
      }, publishedProposalId);
      expect(afterReload).toBe(1);
      expect(receiver.errors).toEqual([]);
      expect(server.requests.some(request => request.path.endsWith('/proposals/batch'))).toBe(true);
    } finally {
      await receiver.context.close();
    }
  });

  test('whole applied plan UI publishes selected members and a fresh device applies the plan once', async ({ mockApi: sender, browser }) => {
    const server = createSharedProposalServer();
    await attachSharedProposalServer(sender, server);
    await openCity(sender);
    await personalizeProfile(sender, 'Plan author');
    const proposalId = await createSpace(sender, 'park');
    const secondParcelId = sampleParcels.features[1].properties.parcelId;
    await sender.evaluate(async (id) => {
      await (window as any).CadastralParcelRepository.ensureIds([id]);
    }, secondParcelId);
    await expect.poll(() => sender.evaluate(id => !!(window as any).ParcelPresenter.getLayer(id), secondParcelId)).toBe(true);
    await openParcel(sender, 'proposals', secondParcelId);
    await sender.locator('.parcel-build-btn--square').click();
    await expect.poll(() => sender.evaluate(() => (window as any).proposalStorage.getAllProposals()
      .some((proposal: any) => proposal.structureProposal?.kind === 'square' && proposal.applied))).toBe(true);
    const secondProposalId = await sender.evaluate(() => (window as any).proposalStorage.getAllProposals()
      .find((proposal: any) => proposal.structureProposal?.kind === 'square' && proposal.applied).proposalId);

    await sender.locator('#proposals-button').click();
    await expect(sender.locator('#proposals-sheet')).toBeVisible();
    await expect(sender.locator('#shareAppliedProposalsButton')).toBeEnabled();
    await sender.locator('#shareAppliedProposalsButton').click();
    // The local proposal key in the row metadata is replaced by the canonical c2 identity when
    // the first publish binds it. Goal labels remain stable across that identity rewrite.
    const row = sender.locator('.share-plan-row').filter({ hasText: /·\s*park/i });
    await expect(row).toBeVisible();
    const secondRow = sender.locator('.share-plan-row').filter({ hasText: /·\s*square/i });
    await expect(secondRow).toBeVisible();
    await row.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(row.locator('span').filter({ hasText: 'Uploaded' })).toBeVisible();
    await secondRow.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(secondRow.locator('span').filter({ hasText: 'Uploaded' })).toBeVisible();
    const planLink = sender.locator('.share-plan-panel .share-modal-link');
    await expect(planLink).toHaveValue(new RegExp(`/proposals/\\d+,\\d+\\?.*city=zg`));
    const shareUrl = await planLink.inputValue();
    expect(server.records.size).toBe(2);
    const publishedByGoal = new Map<string, string>([...server.records.values()]
      .map(record => [String(record.goal), String(record.proposalId)] as [string, string]));
    const publishedParkId = publishedByGoal.get('park');
    const publishedSquareId = publishedByGoal.get('square');
    expect(publishedParkId).toMatch(/^c2-/);
    expect(publishedSquareId).toMatch(/^c2-/);

    const receiver = await receivingDevice(browser, shareUrl, server);
    try {
      await expectAppliedOnFabric(receiver.page, publishedParkId!);
      await expectAppliedOnFabric(receiver.page, publishedSquareId!);
      await receiver.page.reload();
      await waitForMapReady(receiver.page);
      await expectAppliedOnFabric(receiver.page, publishedParkId!);
      await expectAppliedOnFabric(receiver.page, publishedSquareId!);
      const appliedCopies = await receiver.page.evaluate(ids => ids.map(id => (window as any).proposalStorage.getAllProposals()
        .filter((proposal: any) => proposal.proposalId === id && proposal.applied).length), [publishedParkId, publishedSquareId]);
      expect(appliedCopies).toEqual([1, 1]);
      expect(receiver.errors).toEqual([]);
      expect(server.requests.filter(request => request.path.endsWith('/proposals/batch'))).toHaveLength(2);
    } finally {
      await receiver.context.close();
    }
  });

  test('invalid and missing share links show recoverable errors', async ({ browser }) => {
    const server = createSharedProposalServer();
    const invalid = await receivingDevice(browser, '/?city=zg&proposalShare=not-valid-base64!!!', server);
    try {
      await expect(invalid.page.locator('.share-modal-overlay')).toContainText(/Invalid Share Link/i);
      expect(invalid.errors).toEqual([]);
    } finally {
      await invalid.context.close();
    }

    const missing = await receivingDevice(browser, '/proposals/7999?city=zg', server);
    try {
      await expect(missing.page.locator('.share-modal-overlay')).toContainText(/not found on server/i, { timeout: 30_000 });
      expect(missing.errors).toEqual([]);
      expect(server.requests.some(request => request.path.endsWith('/proposals/batch'))).toBe(true);
    } finally {
      await missing.context.close();
    }
  });
});
