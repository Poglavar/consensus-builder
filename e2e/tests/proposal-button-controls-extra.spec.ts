import { selectNativeOption } from '../helpers/controls';
// Exercise proposal modal buttons through the UI, with local server and wallet boundaries.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, createSpace, showProposal, chooseTermsForShare, chooseProposalKind, PARCEL_GEOMETRY, PARCEL_ID, expectStatusLogged } from '../helpers/runtime';
import { connectWalletByConnectorId, injectMockEvmWallet, waitForBlockchainRuntime } from '../helpers/blockchain';
import { attachSharedProposalServer, createSharedProposalServer } from '../helpers/mocks/shared-server';
import { sampleParcels } from '../helpers/mocks/parcel-data';
import { installProposalEvmBoundary, PROPOSAL_EVM_ACCOUNT, PROPOSAL_EVM_CONTRACT, PROPOSAL_MINT_TX } from '../helpers/proposal-chain-boundary';

const WALLET = '0x1234567890abcdef1234567890abcdef12345678';
const BLOCK_PARCEL_IDS = sampleParcels.features.slice(0, 2).map(feature => feature.properties.parcelId);

async function installProposalBlockGround(page: import('@playwright/test').Page): Promise<void> {
  const features = structuredClone(sampleParcels.features.slice(0, 2));
  features[1].geometry.coordinates[0].forEach(point => { if (point[0] === 15.9826) point[0] = 15.9825; });
  await page.route('**/parcels**', route => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET' || !/\/parcels(?:\/parcelIds)?$/.test(url.pathname)) return route.continue();
    const requested = url.searchParams.get('ids')?.split(',');
    return route.fulfill({ json: { type: 'FeatureCollection', features: features.filter(feature => !requested || requested.includes(feature.properties.parcelId)) } });
  });
}

async function openBlockProposalDialog(page: import('@playwright/test').Page): Promise<void> {
  // The block's Create Proposal action opens a new proposal dialog without a forked editor draft.
  // This exercises the supported EVM-mint path and avoids pretending a fork's abstract approval
  // setup is chain-compatible.
  await page.evaluate(async ids => (window as any).CadastralParcelRepository.ensureIds(ids), BLOCK_PARCEL_IDS);
  await openParcel(page, 'info', BLOCK_PARCEL_IDS[1]);
  await page.locator('#layers-button').click();
  const tools = page.locator('#layers-sheet details.layer-actions:has(> summary[data-i18n-key="mapShell.reorg.blockData"])');
  if (!(await tools.evaluate((element: HTMLDetailsElement) => element.open))) await tools.locator('> summary').click();
  await tools.locator('[onclick="animateFloodfillFromSelected()"]')!.click();
  await expect.poll(() => page.evaluate(() => (window as any).multiParcelSelection.selectedParcels.size)).toBeGreaterThan(1);
  await tools.locator('[onclick="countBlocks()"]')!.click();
  await expect.poll(() => page.evaluate(() => (window as any).blockStorage.blocks.size)).toBeGreaterThan(0);
  await page.locator('#showBlockListButton').click();
  await page.locator('#blocks-content .block-item').first().click();
  await page.locator('#layers-sheet [data-sheet-close]').click();
  await expect(page.locator('#block-info-panel')).toBeVisible();
  await page.locator('#block-proposals-tab-button').click();
  await page.locator('#block-proposals-content').getByRole('button', { name: 'Create proposal', exact: true }).click();
  await expect(page.locator('.create-proposal-modal:visible')).toBeVisible();
}

async function establishLocalProfile(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('#username-display').click();
  await expect(page.locator('#welcome-modal')).toBeVisible();
  await page.locator('#username-input').fill('Button control tester');
  await page.locator('#welcome-submit-btn').click();
  await expect(page.locator('#welcome-modal')).toBeHidden();
}

async function prepareMissingParcelShareMint(page: import('@playwright/test').Page): Promise<string> {
  await injectMockEvmWallet(page, { account: PROPOSAL_EVM_ACCOUNT, chainIdHex: '0x14a34', walletKind: 'metamask' });
  await openCity(page);
  await establishLocalProfile(page);
  await connectWalletByConnectorId(page, 'metamask');
  await waitForBlockchainRuntime(page, ['ProposalChainBridge', 'ethers']);
  await installProposalEvmBoundary(page, { parcelAlreadyMinted: false });
  const id = await page.evaluate(({ parcelId, geometry, wallet }) => (window as any).proposalStorage.addProposal({
    proposalId: 'missing-parcel-share-mint-source', title: 'Share mint prerequisite',
    description: 'A legacy proposal with land that has not been minted.', goal: 'park', lifecycleStatus: 'Active',
    kind: 'community-vote', termsConfirmed: true,
      city: 'zagreb',
    cadastreParcelIds: [parcelId], geometry, structureProposal: { kind: 'park', geometry, applied: true },
    lens: [{ address: wallet }], screenshotDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
  }), { parcelId: PARCEL_ID, geometry: PARCEL_GEOMETRY, wallet: WALLET });
  await showProposal(page, id);
  await page.locator('#proposal-details-footer .btn-share-proposal').click();
  await expect(page.locator('.share-modal-overlay')).toBeVisible();
  return id;
}

async function openProposalList(page: import('@playwright/test').Page) {
  await page.locator('#proposals-button').click();
  return page.locator('#proposals-sheet .proposal-list-modal');
}

async function openMintedProposals(page: import('@playwright/test').Page) {
  await openProposalList(page);
  const actions = page.locator('#proposal-list-actions');
  if (!(await actions.evaluate((element: HTMLDetailsElement) => element.open))) {
    await actions.locator(':scope > summary').click();
  }
  await page.locator('#mintedProposalsButton').click();
}

async function prepareMintedProposalModal(page: import('@playwright/test').Page): Promise<void> {
  await injectMockEvmWallet(page, { account: WALLET, chainIdHex: '0x14a34', walletKind: 'metamask' });
  await openCity(page);
  await connectWalletByConnectorId(page, 'metamask');
  await waitForBlockchainRuntime(page, ['ChainDataLoader', 'ethers']);
  await installProposalEvmBoundary(page, { includeMintedProposal: true });
}

async function prepareProposalCreationMint(page: import('@playwright/test').Page, failMint: boolean): Promise<void> {
  await injectMockEvmWallet(page, { account: WALLET, chainIdHex: '0x14a34', walletKind: 'metamask' });
  await installProposalBlockGround(page);
  await openCity(page);
  await establishLocalProfile(page);
  await connectWalletByConnectorId(page, 'metamask');
  await waitForBlockchainRuntime(page, ['ProposalChainBridge', 'ethers']);
  await installProposalEvmBoundary(page, { parcelAlreadyMinted: true, failProposalMint: failMint });
  await page.evaluate(address => (window as any).LensPicker.setEntries([{ address }]), PROPOSAL_EVM_ACCOUNT);
  await openBlockProposalDialog(page);
  const create = page.locator('.create-proposal-modal:visible');
  await create.locator('.proposal-radio:has(input[name="proposalLandUse"][value="park"])').click();
  await expect(create.locator('input[name="proposalLandUse"][value="park"]')).toBeChecked();
}

async function expectProposalMintRpc(page: import('@playwright/test').Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (window as any).__proposalEvmBoundary
    .filter((method: string) => method === 'eth_sendTransaction').length)).toBeGreaterThan(0);
  // The mint asks for 25% over the boundary's 21000-gas estimate (wallet wrappers spend gas too).
  expect(BigInt(await page.evaluate(() => (window as any).__proposalEvmSubmitted.gas))).toBe(26250n);
}

test.describe('proposal button controls: modal and alternate states @features', () => {
  test('fresh proposal land-use and parcel choices update the geometry and ownership requirements', async ({ mockApi: page }) => {
    test.setTimeout(60_000);
    await installProposalBlockGround(page);
    await openCity(page);
    await openBlockProposalDialog(page);
    const create = page.locator('.create-proposal-modal:visible');
    for (const landUse of ['square', 'lake', 'single', 'as-is']) {
      await create.locator(`.proposal-radio:has(input[name="proposalLandUse"][value="${landUse}"])`).click();
      await expect.poll(() => page.evaluate(() => (window as any).proposalFacets?.landUse)).toBe(landUse);
      const ownership = landUse === 'single' ? 'to-me' : landUse === 'as-is' ? 'no-change' : 'to-city';
      await expect.poll(() => page.evaluate(() => (window as any).proposalFacets?.ownership)).toBe(ownership);
      if (landUse === 'as-is') await expect(create.locator('#proposalParcelsStatic')).toBeHidden();
      else await expect(create.locator('#proposalParcelsStatic')).toBeVisible();
    }
    await create.locator('.proposal-radio:has(input[name="proposalParcelsMode"][value="readjust"])').click();
    await expect.poll(() => page.evaluate(() => (window as any).proposalFacets)).toMatchObject({ parcels: 'readjust', ownership: 'per-slice' });
    await expect(create.locator('#proposalOwnershipStatic')).toContainText('Per slice');
    await create.locator('.proposal-radio:has(input[name="proposalParcelsMode"][value="as-is"])').click();
    await expect.poll(() => page.evaluate(() => (window as any).proposalFacets)).toMatchObject({ parcels: 'as-is', ownership: 'no-change' });
    await expect(create.locator('#proposalOwnershipStatic')).toBeHidden();
    await expect(create.locator('#createProposalSubmitButton')).toBeDisabled();
  });

  test('proposal summary expands the selected parcel details and collapses them again', async ({ mockApi: page }) => {
    await installProposalBlockGround(page);
    await openCity(page);
    await openBlockProposalDialog(page);
    const create = page.locator('.create-proposal-modal:visible');
    await create.locator('#proposalOptionsSection > .collapsible-header').click();
    const toggle = create.locator('#proposalSummarySection > .collapsible-header');
    const content = create.locator('#proposalSummaryContent');
    await expect(content).toBeHidden();
    await toggle.click();
    await expect(content).toBeVisible();
    await expect(content.locator('.proposal-parcel-item')).toHaveCount(BLOCK_PARCEL_IDS.length);
    await toggle.click();
    await expect(content).toBeHidden();
  });

  test('minted proposal modal refreshes, exposes metadata and details, and closes both dialogs', async ({ mockApi: page }) => {
    await prepareMintedProposalModal(page);
    await openMintedProposals(page);
    const modal = page.locator('.minted-proposals-overlay');
    await expect(modal).toBeVisible();
    const initialReads = await page.evaluate(() => (window as any).__proposalEvmBoundary.filter((method: string) => method === 'eth_call').length);
    await modal.locator('.minted-proposals-refresh').click();
    await expect.poll(() => page.evaluate(() => (window as any).__proposalEvmBoundary.filter((method: string) => method === 'eth_call').length)).toBeGreaterThan(initialReads);

    await modal.locator('.minted-proposal-metadata-btn').click();
    const metadata = page.locator('.minted-metadata-overlay');
    await expect(metadata).toContainText('Saved on-chain metadata.');
    await metadata.locator('.minted-metadata-header .close-circle-btn').click();
    await expect(metadata).toBeHidden();

    await modal.locator('.minted-proposal-metadata-btn').click();
    await page.locator('.minted-metadata-footer').getByRole('button', { name: 'OK', exact: true }).click();
    await expect(metadata).toBeHidden();

    await modal.locator('.minted-proposal-details-btn').click();
    await expect(modal).toBeHidden();
    await expect(page.locator('#proposal-details-panel')).toBeVisible();
    await expect(page.locator('#proposal-details-panel')).toContainText('Modal garden');

    await openMintedProposals(page);
    await expect(modal).toBeVisible();
    await modal.locator('.minted-proposals-close').click();
    await expect(modal).toBeHidden();
  });

  test('proposal mint success View and OK buttons open the explorer and finish the create flow', async ({ mockApi: page }) => {
    await prepareProposalCreationMint(page, false);
    const create = page.locator('.create-proposal-modal:visible');
    await create.locator('#proposalName').fill('Mint confirmation test');
    await chooseProposalKind(create, 'owner-deal');
    await create.locator('#proposalOptionsSection > .collapsible-header').click();
    await create.locator('#proposalOffer').fill('100');
    await selectNativeOption(create.locator('#proposalCurrency'), 'EUR');
    await create.locator('#createProposalSubmitButton').click();
    await expectProposalMintRpc(page);
    const success = page.locator('#proposal-mint-success-modal');
    await expect(success).toContainText('Proposal minted', { timeout: 30000 });
    await expect(success).toContainText('Token/account: 77');
    await expect(success).toContainText(`Contract/program: ${PROPOSAL_EVM_CONTRACT}`);
    await expect(success).toContainText(/Chain: evm \/ (84532|0x14a34)/);

    await page.context().route('https://sepolia.basescan.org/**', route => route.fulfill({
      contentType: 'text/html', body: '<title>Explorer boundary</title>'
    }));
    const popupPromise = page.waitForEvent('popup');
    await Promise.all([
      success.getByRole('button', { name: 'View transaction', exact: true }).click(),
      popupPromise.then(async popup => {
        await expect.poll(() => popup.url()).toContain(`sepolia.basescan.org/tx/${PROPOSAL_MINT_TX}`);
        await popup.close();
      }),
    ]);

    await success.getByRole('button', { name: 'OK', exact: true }).click();
    await expect(success).toBeHidden();
    await expect(page.locator('#proposal-details-panel')).toContainText('Mint confirmation test');
    await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().some((p: any) => p.title === 'Mint confirmation test' && p.nft?.tokenId === '77'))).toBe(true);
  });

  test('proposal mint failure Cancel leaves the user in the editable dialog with a retryable status', async ({ mockApi: page }) => {
    await prepareProposalCreationMint(page, true);
    const create = page.locator('.create-proposal-modal:visible');
    await create.locator('#proposalName').fill('Retry mint failure');
    await chooseProposalKind(create, 'owner-deal');
    await create.locator('#proposalOptionsSection > .collapsible-header').click();
    await create.locator('#proposalOffer').fill('100');
    await selectNativeOption(create.locator('#proposalCurrency'), 'EUR');
    await create.locator('#createProposalSubmitButton').click();
    await expectProposalMintRpc(page);
    const failure = page.locator('.cb-dialog-overlay--confirm');
    await expect(failure).toContainText('On-chain mint failed for reason:', { timeout: 30000 });
    await expect(failure).toContainText(/insufficient funds/i);
    await failure.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(failure).toBeHidden();
    await expect(create).toBeVisible();
    await expectStatusLogged(page, 'Proposal creation cancelled.');
    await expect(create.locator('#createProposalSubmitButton')).toBeEnabled();
    await expect(create.locator('#proposalName')).toHaveValue('Retry mint failure');
    expect(await page.evaluate(() => (window as any).proposalStorage.getAllProposals()
      .some((proposal: any) => proposal.title === 'Retry mint failure'))).toBe(false);
  });

  test('proposal mint failure Create in memory saves locally without a minted record', async ({ mockApi: page }) => {
    await prepareProposalCreationMint(page, true);
    const create = page.locator('.create-proposal-modal:visible');
    await create.locator('#proposalName').fill('Fallback in-memory proposal');
    await chooseProposalKind(create, 'owner-deal');
    await create.locator('#proposalOptionsSection > .collapsible-header').click();
    await create.locator('#proposalOffer').fill('100');
    await selectNativeOption(create.locator('#proposalCurrency'), 'EUR');
    const before = await page.evaluate(() => (window as any).proposalStorage.getAllProposals().length);
    await create.locator('#createProposalSubmitButton').click();
    await expectProposalMintRpc(page);
    const failure = page.locator('.cb-dialog-overlay--confirm');
    await expect(failure).toContainText('On-chain mint failed for reason:', { timeout: 30000 });
    await expect(failure).toContainText(/insufficient funds/i);
    await failure.getByRole('button', { name: 'Create in memory', exact: true }).click();
    await expect(failure).toBeHidden();
    await expect(create).toBeHidden({ timeout: 30000 });
    await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().length)).toBeGreaterThan(before);
    const saved = await page.evaluate(() => (window as any).proposalStorage.getAllProposals().find((p: any) => p.title === 'Fallback in-memory proposal'));
    expect(saved).toBeTruthy();
    expect(saved.nft).toBeFalsy();
    expect(saved.onchain).toBeFalsy();
  });

  test('missing-parcel mint dialog Cancel, Create in memory and prerequisite mint each return a verified result', async ({ mockApi: page }) => {
    const proposalId = await prepareMissingParcelShareMint(page);
    const share = page.locator('.share-modal-overlay');
    const mint = () => share.getByRole('button', { name: 'Mint', exact: true }).click();

    await mint();
    const confirmation = page.locator('.cb-dialog-overlay--confirm');
    await expect(confirmation).toContainText('not represented as an NFT');
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(confirmation).toBeHidden();
    await expect(share).toContainText('Mint cancelled.');

    await mint();
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole('button', { name: 'Create in memory', exact: true }).click();
    await expect(confirmation).toBeHidden();
    await expect(share).toContainText('Mint skipped. Proposal remains in memory.');
    expect(await page.evaluate(id => (window as any).proposalStorage.getProposal(id)?.proposalId, proposalId)).toBeTruthy();

    await mint();
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole('button', { name: 'Mint the prerequisites', exact: true }).click();
    const parcelMint = page.locator('#parcel-mint-modal-overlay');
    await expect(parcelMint).toBeVisible();
    await parcelMint.locator('.parcel-mint-close').click();
    await expect(parcelMint).toBeHidden();
    await expect(share).toContainText('Mint the prerequisite parcel NFTs, then mint the proposal.');
  });

  test('applied-proposal selection, row upload, copy and named-plan creation all change the visible state', async ({ mockApi: page }) => {
    const server = createSharedProposalServer();
    await attachSharedProposalServer(page, server);
    let submittedPlanBody: Record<string, unknown> | null = null;
    await page.route('**/plans', route => {
      if (route.request().method() === 'POST') {
        submittedPlanBody = route.request().postDataJSON();
      }
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ name: 'greenway.proposals.urbangametheory.eth' })
      });
    });
    await openCity(page);
    await establishLocalProfile(page);
    const id = await createSpace(page, 'park');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
    await showProposal(page, id);
    await page.locator('#proposal-details-footer .btn-share-proposal').click();
    await chooseTermsForShare(page);
    await page.getByRole('button', { name: 'Share applied proposals', exact: true }).click();

    const plan = page.locator('.share-plan-panel');
    await expect(plan).toBeVisible({ timeout: 30000 });
    await expect(plan.getByRole('heading', { name: 'Share applied proposals', exact: true })).toBeVisible();
    await expect(plan).toContainText('A named plan keeps that selection fixed');
    await test.info().attach('applied-proposal-sharing', { body: await plan.screenshot(), contentType: 'image/png' });
    const highlightAll = plan.getByRole('button', { name: 'All', exact: true });
    await plan.getByRole('button', { name: 'Not uploaded yet', exact: true }).click();
    await highlightAll.click();
    await expect(highlightAll).toHaveAttribute('aria-pressed', 'true');
    const row = plan.locator('.share-plan-row').first();
    const selected = row.locator('input[type="checkbox"]');
    await selected.uncheck();
    await expect(plan).toContainText('Select at least one proposal to share.');
    await selected.check();
    await row.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(row).toContainText('Uploaded', { timeout: 30000 });
    const selectedUploadedRowIds = [...server.records.keys()].map(String);
    expect(selectedUploadedRowIds.length).toBeGreaterThan(0);
    const publishedLocal = await page.evaluate(key => {
      const store = (window as any).proposalStorage;
      const record = store.getProposal(key);
      return { proposalId: record.proposalId, id: record.id, serverProposalId: record.serverProposalId,
        indexedKeys: [...store.proposals.entries()].filter(([, value]) => value === record).map(([key]) => key) };
    }, id);
    expect(publishedLocal.proposalId).toBe(id);
    expect(publishedLocal.id).toBe(publishedLocal.serverProposalId);
    expect(selectedUploadedRowIds).toContain(publishedLocal.id);
    expect(publishedLocal.indexedKeys).toEqual([id]);
    const link = plan.locator('.share-modal-link');
    await expect(link).toHaveValue(/\/proposals\/\d+/);
    const url = await link.inputValue();
    await plan.getByRole('button', { name: 'Copy URL', exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(url);
    expect(submittedPlanBody).toBeNull(); // Sharing a selection does not create a named plan.

    const nameInput = plan.locator('input').last();
    // The blank-name action validates without a network request; a valid name then exercises the save path.
    const saveName = plan.getByRole('button', { name: 'Create named plan', exact: true });
    await saveName.click();
    await expect(plan).toContainText('Use at least 3 characters');
    expect(submittedPlanBody).toBeNull();
    await nameInput.fill('greenway');
    await saveName.click();
    await expect(plan).toContainText('greenway.proposals.urbangametheory.eth');
    expect(submittedPlanBody).toBeTruthy();
    expect(submittedPlanBody?.proposalRowIds).toEqual(selectedUploadedRowIds);
    expect(submittedPlanBody).not.toHaveProperty('proposalIds');
    await plan.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(plan).toBeHidden();
  });

  test('uploaded proposal passes its link to Tweet and native Share', async ({ mockApi: page }) => {
    const server = createSharedProposalServer();
    await attachSharedProposalServer(page, server);
    // Keep the real Share handler; intercept only the operating-system share sheet boundary.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: async (payload: ShareData) => { (window as any).__nativeSharePayload = payload; }
      });
    });
    await openCity(page);
    await establishLocalProfile(page);
    const id = await createSpace(page, 'park');
    await showProposal(page, id);
    await page.locator('#proposal-details-footer .btn-share-proposal').click();
    await chooseTermsForShare(page);
    const share = page.locator('.share-modal-overlay');
    await share.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(share.locator('.share-modal-share-actions')).toBeVisible();
    const proposalUrl = await share.locator('.share-modal-link').first().inputValue();

    let intentUrl: URL | null = null;
    await page.context().route('https://twitter.com/intent/tweet**', async route => {
      intentUrl = new URL(route.request().url());
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Tweet intent boundary</title>' });
    });
    const popupComplete = page.waitForEvent('popup').then(async popup => {
      await expect.poll(() => intentUrl?.pathname).toBe('/intent/tweet');
      expect(intentUrl?.searchParams.get('text')).toBe('I have created a new urban proposal!');
      expect(intentUrl?.searchParams.get('url')).toBe(proposalUrl);
      await popup.close();
    });
    await Promise.all([popupComplete, share.getByRole('button', { name: /X\.com/i }).click()]);

    await share.getByRole('button', { name: /Share…|Share\.\.\./ }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__nativeSharePayload)).toMatchObject({
      url: proposalUrl,
      text: 'I have created a new urban proposal!'
    });
  });

  test('proposal list epoch buttons move the cumulative timeline and restore all years', async ({ mockApi: page }) => {
    await openCity(page);
    await page.evaluate((parcelId) => {
      const storage = (window as any).proposalStorage;
      storage.addProposal({ title: 'Early stage', goal: 'park', lifecycleStatus: 'Active', cadastreParcelIds: [parcelId], epochYear: 2035 });
      storage.addProposal({ title: 'Later stage', goal: 'square', lifecycleStatus: 'Active', cadastreParcelIds: [parcelId], epochYear: 2045 });
    }, PARCEL_ID);
    const list = await openProposalList(page);
    const timeline = list.locator('.proposal-epoch-timeline');
    await expect(timeline).toBeVisible();
    await timeline.getByRole('button', { name: '2035.', exact: true }).click();
    await expect(timeline.getByRole('button', { name: '2035.', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(timeline).toContainText(/Cumulative to 2035/);
    await timeline.getByRole('button', { name: '2045.', exact: true }).click();
    await expect(timeline.getByRole('button', { name: '2045.', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await timeline.getByRole('button', { name: 'All', exact: true }).click();
    await expect(timeline.locator('.proposal-epoch-diff')).toHaveCount(0);
  });

  test('road designation close discards the draft while Done commits the selected parcel boundary', async ({ mockApi: page }) => {
    await installProposalBlockGround(page);
    await openCity(page);
    await establishLocalProfile(page);
    await openBlockProposalDialog(page);
    const create = page.locator('.create-proposal-modal:visible');
    await create.locator('.proposal-radio:has(input[name="proposalLandUse"][value="road-track"])').click();
    await create.locator('#proposalGeometryButtons [data-geometry-action="edit"]').click();
    const modal = page.locator('.constrained-corridor-overlay');
    await expect(modal).toBeVisible();
    await modal.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(modal).toBeHidden();
    expect(await page.evaluate(() => (window as any).pendingConstrainedCorridor ?? null)).toBeNull();

    await create.locator('#proposalGeometryButtons [data-geometry-action="edit"]').click();
    await expect(modal).toBeVisible();
    await modal.locator('[data-corridor-done]').click();
    await expect(modal).toBeHidden();
    const saved = await page.evaluate(() => (window as any).pendingConstrainedCorridor);
    expect(saved).toMatchObject({ mode: 'full', type: 'road', centerline: [] });
    expect(saved.parcelIds.slice().sort()).toEqual(BLOCK_PARCEL_IDS.slice().sort());
    expect(saved.polygon.type).toMatch(/Polygon/);
  });

  test('server proposal retry recovers the proposal list after one failed request', async ({ mockApi: page }) => {
    let requests = 0;
    let allowRecovery = false;
    await page.route('**/proposals/summary**', async route => {
      requests += 1;
      if (!allowRecovery) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary test outage' }) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ proposals: [] }) });
    });
    await openCity(page);
    const list = await openProposalList(page);
    await list.locator('.proposal-source-btn[data-source="server"]').click();
    await expect.poll(() => requests).toBeGreaterThan(0);
    const retry = list.locator('.proposal-server-retry');
    await expect(retry).toBeVisible();
    allowRecovery = true;
    await retry.click();
    await expect.poll(() => requests).toBeGreaterThanOrEqual(2);
    await expect(list.locator('.proposal-list-error')).toHaveCount(0);
  });

  test('a published binding-drift notice rebinds a new immutable record and opens an already rebound record', async ({ mockApi: page }) => {
    const server = createSharedProposalServer();
    await attachSharedProposalServer(page, server);
    await openCity(page);
    await establishLocalProfile(page);
    await page.evaluate(() => (window as any).i18n.setLanguage('en'));
    const sourceId = await page.evaluate(parcelId => (window as any).proposalStorage.addProposal({
      proposalId: 'published-source-741', title: 'Published source', goal: 'park', lifecycleStatus: 'Active',
      city: 'zagreb', cadastreParcelIds: [parcelId],
      serverProposalId: '741', geometry: { type: 'Polygon', coordinates: [[[15.98,45.8],[15.981,45.8],[15.981,45.801],[15.98,45.801],[15.98,45.8]]] },
      binding: { coverage: 'full', parcels: [{ parcelId, overlapM2: 100, intrusionM: 0 }], unsurveyedM2: 0 }
    }), PARCEL_ID);
    const driftResponse = {
      stored: { computedAt: '2026-01-01T00:00:00.000Z', coverage: 'full', parcels: [{ parcelId: PARCEL_ID, overlapM2: 100, intrusionM: 0 }], unsurveyedM2: 0 },
      current: { computedAt: '2026-01-02T00:00:00.000Z', coverage: 'full', parcels: [{ parcelId: 'HR-335754-1235', overlapM2: 98, intrusionM: 0 }], unsurveyedM2: 0 },
      drift: { added: [{ parcelId: 'HR-335754-1235' }], removed: [{ parcelId: PARCEL_ID }], coverageChanged: false, coverage: { from: 'full', to: 'full' }, openGroundM2: { from: 0, to: 0 } }
    };
    let driftRequests = 0;
    await page.route('**/proposals/741/binding-drift', route => {
      driftRequests += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(driftResponse) });
    });
    expect(await page.evaluate(id => (window as any).getSerialProposalId((window as any).proposalStorage.getProposal(id)), sourceId)).toBe('741');
    await showProposal(page, sourceId);
    const details = page.locator('#proposal-details-panel');
    const expand = details.getByRole('button', { name: 'Expand', exact: true });
    if (await expand.isVisible()) await expand.click();
    await expect(details.locator('.panel-body')).toBeVisible();
    const drift = page.locator('.proposal-binding-drift');
    await expect.poll(() => driftRequests).toBe(1);
    await expect(drift).toContainText('Now also reaches');
    await drift.getByRole('button', { name: 'Re-bind', exact: true }).click();
    const confirm = page.locator('.cb-dialog-overlay--confirm');
    await expect(confirm).toContainText('Publish a new record with the same site and design');
    await confirm.getByRole('button', { name: 'Re-bind', exact: true }).click();
    await expect.poll(() => page.evaluate(id => (window as any).proposalStorage.getAllProposals().some((p: any) => p.rebind?.sourceProposalId === id), sourceId)).toBe(true);
    await expect.poll(() => server.records.size).toBe(1);
    await expect.poll(() => page.evaluate(id => (window as any).proposalStorage.getProposal(id)?.title, sourceId)).toBe('Published source');

    const derivedId = await page.evaluate(id => (window as any).proposalStorage.getAllProposals().find((p: any) => p.rebind?.sourceProposalId === id)?.proposalId, sourceId);
    await page.route('**/proposals/741/binding-drift', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(driftResponse) }));
    await page.evaluate(({ id }) => {
      const storage = (window as any).proposalStorage;
      const derived = storage.getProposal(id);
      derived.title = 'Already rebound';
      storage.save();
    }, { id: derivedId });
    await showProposal(page, sourceId);
    const expandedAgain = page.locator('#proposal-details-panel').getByRole('button', { name: 'Expand', exact: true });
    if (await expandedAgain.isVisible()) await expandedAgain.click();
    const openRebound = page.locator('.proposal-binding-drift [data-binding-drift-open]');
    await expect(openRebound).toBeVisible();
    await openRebound.click();
    await expect(page.locator('#proposal-details-title')).toHaveText('Already rebound');
  });
});
