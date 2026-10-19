// Additional proposal-control coverage for chain, editor, ownership, and sharing actions uses local external boundaries.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, createSpace, showProposal, chooseTermsForShare, chooseProposalKind, PARCEL_GEOMETRY, PARCEL_ID } from '../helpers/runtime';
import { attachSharedProposalServer, createSharedProposalServer } from '../helpers/mocks/shared-server';
import { connectWalletByConnectorId, injectMockEvmWallet, injectMockSolanaWallet, waitForBlockchainRuntime } from '../helpers/blockchain';
import { installProposalEvmBoundary, PROPOSAL_EVM_ACCOUNT } from '../helpers/proposal-chain-boundary';
import { installSolanaExternalBoundary } from '../helpers/solana-external-boundary';
import { sampleParcels } from '../helpers/mocks/parcel-data';
import { openAndClosePopup } from '../helpers/controls';

const EVM_WALLET = PROPOSAL_EVM_ACCOUNT;
const SOLANA_WALLET = '7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT';
const PROPOSAL_ACCOUNT = '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg';
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

async function openFreshProposalFromBlock(page: import('@playwright/test').Page): Promise<void> {
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

// App handlers remain intact; only wallet/API boundaries are local.

async function establishLocalProfile(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('#username-display').click();
  await expect(page.locator('#welcome-modal')).toBeVisible();
  await page.locator('#username-input').fill('Proposal sixth-pass tester');
  await page.locator('#welcome-submit-btn').click();
  await expect(page.locator('#welcome-modal')).toBeHidden();
}

async function installMarketRpcFixture(page: import('@playwright/test').Page, marketExists = true, connectWallet = true): Promise<void> {
  await page.route('**/markets?*', route => route.fulfill({ json: { contests: [] } }));
  await page.evaluate(({ proposal, wallet, marketExists, connectWallet }) => {
    const w = window as any;
    const client = w.SolanaMarketClient;
    const web3 = w.solanaWeb3;
    const proposalKey = new web3.PublicKey(proposal);
    const walletKey = new web3.PublicKey(wallet);
    const mintKey = new web3.PublicKey(client.DEVNET_USDC_MINT || '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
    const [marketPda] = client.getMarketPda(proposalKey);
    const [yesPosition] = client.getPositionPda(marketPda, walletKey, client.constants.SIDE_YES);
    const marketBytes = new Uint8Array(client.MARKET_SIZE);
    let offset = 0;
    const put = (bytes: Uint8Array) => { marketBytes.set(bytes, offset); offset += bytes.length; };
    put(Uint8Array.from([219, 190, 213, 55, 0, 227, 198, 154]));
    put(proposalKey.toBytes()); put(mintKey.toBytes()); put(new Uint8Array(32));
    const writeU64 = (value: bigint) => { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, value, true); put(bytes); };
    writeU64(4_000_000n); writeU64(2_000_000n);
    put(Uint8Array.of(0, 1, 1));
    const positionBytes = new Uint8Array(client.POSITION_SIZE);
    offset = 0;
    const writePosition = (bytes: Uint8Array) => { positionBytes.set(bytes, offset); offset += bytes.length; };
    writePosition(Uint8Array.from([170, 188, 143, 228, 122, 64, 247, 208]));
    writePosition(marketPda.toBytes()); writePosition(walletKey.toBytes()); writePosition(Uint8Array.of(1));
    const amount = new Uint8Array(8); new DataView(amount.buffer).setBigUint64(0, 1_000_000n, true); writePosition(amount);
    writePosition(Uint8Array.of(0, 1));
    const accounts = new Map<string, Uint8Array>(marketExists
      ? [[marketPda.toBase58(), marketBytes], [yesPosition.toBase58(), positionBytes]]
      : []);
    const events: string[] = [];
    const connection = {
      getAccountInfo: async (key: any) => { const data = accounts.get(key.toBase58()); return data ? { data, owner: new web3.PublicKey(client.constants.PROGRAM_ID) } : null; },
      getBalance: async () => 2_000_000_000,
      getTokenAccountBalance: async () => ({ value: { amount: '50000000', decimals: 6 } }),
      getLatestBlockhash: async () => ({ blockhash: 'EkSnNWid2cvwEVnVx9aBqpiCpY1QoUW63D2Hp31e4gwJ', lastValidBlockHeight: 99 }),
      simulateTransaction: async () => ({ value: { err: null, logs: [] } }),
      sendRawTransaction: async () => { events.push('send'); return '5N2o4X1mockSignature'; },
      confirmTransaction: async () => { events.push('confirm'); return { value: { err: null } }; },
    };
    const provider = w.solanaWalletManager?.getProvider?.();
    if (connectWallet && !provider) throw new Error('Connected Solana provider is unavailable');
    if (provider) provider.signTransaction = async (transaction: any) => {
        w.__proposalMarketSignedInstructionData = (transaction.instructions || []).map((instruction: any) => Array.from(instruction.data || []));
        transaction.serialize = () => new Uint8Array([1, 2, 3]);
        return transaction;
    };
    w.__proposalMarketRpcEvents = events;
    w.SolanaChainDataLoader.getConnection = () => connection;
  }, { proposal: PROPOSAL_ACCOUNT, wallet: SOLANA_WALLET, marketExists, connectWallet });
}

test.describe('proposal button controls sixth pass @features', () => {
  test('uploaded-share dialog copies the minted token explorer URL and closes', async ({ mockApi: page }) => {
    await openCity(page);
    await establishLocalProfile(page);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
    const proposalId = await page.evaluate(({ parcelId, geometry }) => (window as any).proposalStorage.addProposal({
      title: 'Minted share explorer target', goal: 'park', lifecycleStatus: 'Active', cadastreParcelIds: [parcelId], geometry,
      isMinted: true,
      nft: { chain: '84532', contract: '0x1234567890123456789012345678901234567890', tokenId: '77' },
    }), { parcelId: PARCEL_ID, geometry: PARCEL_GEOMETRY });
    await showProposal(page, proposalId);
    await page.locator('#proposal-details-footer .btn-share-proposal').click();

    const modal = page.locator('.share-modal-overlay');
    await expect(modal).toBeVisible();
    const input = modal.locator('.share-modal-link').nth(1);
    const explorerUrl = await input.inputValue();
    expect(explorerUrl).toBe('https://sepolia.basescan.org/token/0x1234567890123456789012345678901234567890?a=77');
    const copy = modal.getByRole('button', { name: 'Copy URL', exact: true }).last();
    await copy.click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(explorerUrl);
    await modal.locator('.share-modal .close-circle-btn').click();
    await expect(modal).toBeHidden();
  });

  test('minted proposal modal View on Explorer opens the current contract token page', async ({ mockApi: page }) => {
    await injectMockEvmWallet(page, { account: EVM_WALLET, chainIdHex: '0x14a34', walletKind: 'metamask' });
    await openCity(page);
    await connectWalletByConnectorId(page, 'metamask');
    await waitForBlockchainRuntime(page, ['ChainDataLoader', 'BlockchainSync', 'ethers']);
    await installProposalEvmBoundary(page, { includeMintedProposal: true });
    await page.locator('#proposals-button').click();
    const planActions = page.locator('#proposal-list-actions');
    if (!(await planActions.evaluate(element => (element as HTMLDetailsElement).open))) await planActions.locator(':scope > summary').click();
    await page.locator('#mintedProposalsButton').click();
    const modal = page.locator('.minted-proposals-overlay');
    await expect(modal).toBeVisible();
    const link = modal.getByRole('link', { name: /View on explorer/i }).first();
    await expect(link).toHaveAttribute('href', /sepolia\.basescan\.org\/token\//);
    const target = await link.getAttribute('href');
    await page.context().route('https://sepolia.basescan.org/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Explorer boundary</title>' }));
    await openAndClosePopup(page, () => link.click(), async popup => {
      await expect.poll(() => popup.url()).toBe(target);
    });
    await modal.locator('.minted-proposals-close').click();
    await expect(modal).toBeHidden();
  });

  test('server proposal Download imports the selected record into this browser', async ({ mockApi: page }) => {
    const server = createSharedProposalServer();
    server.records.set('7017', {
      id: 7017, proposalId: 'published-server-record-7017', title: 'Downloadable proposal',
      goal: 'park', lifecycleStatus: 'Active', cadastreParcelIds: [PARCEL_ID], geometry: PARCEL_GEOMETRY,
    });
    await attachSharedProposalServer(page, server);
    await openCity(page);
    await page.evaluate(() => (window as any).i18n.setLanguage('en'));
    await page.locator('#proposals-button').click();
    const list = page.locator('#proposals-sheet .proposal-list-modal');
    await list.locator('.proposal-source-btn[data-source="server"]').click();
    const row = list.locator('.proposal-list-item').filter({ hasText: 'Downloadable proposal' });
    await expect(row).toBeVisible();
    await row.locator('.proposal-download-btn').click();
    await expect(row.locator('.proposal-download-btn')).toBeDisabled();
    await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals()
      .some((proposal: any) => proposal.serverProposalId === '7017' && proposal.title === 'Downloadable proposal'))).toBe(true);
  });

  test('create-dialog geometry Edit launches the selected urban-rule geometry tool', async ({ mockApi: page }) => {
    await installProposalBlockGround(page);
    await openCity(page);
    await openFreshProposalFromBlock(page);
    const create = page.locator('.create-proposal-modal:visible');
    await create.locator('.proposal-radio:has(input[name="proposalLandUse"][value="urban-rule"])').click();
    const edit = create.locator('#proposalGeometryButtons [data-geometry-action="edit"]');
    await expect(edit).toBeVisible();
    await edit.click();
    await expect.poll(() => page.evaluate(() => (window as any).getSelectedProposalTool?.())).toBe('buildings');
    const editor = page.locator('#blockify-modal');
    await expect(editor.locator('.on-map-editor__panel')).toBeVisible();
    await expect(editor.locator('#btn-blockify-done')).toBeEnabled();
    await expect.poll(() => page.evaluate(() => {
      const features = (window as any).OnMapEditor?.getPreview?.()?.draftPreview?.features;
      return Array.isArray(features) ? features.filter((feature: any) => feature?.geometry).length : 0;
    })).toBeGreaterThan(0);
  });

  test('details Edit geometry opens the existing proposal geometry tool', async ({ mockApi: page }) => {
    await openCity(page);
    const proposalId = await createSpace(page, 'park');
    await showProposal(page, proposalId);
    const edit = page.locator('#proposal-details-footer .btn-edit-geometry');
    await expect(edit).toBeVisible();
    await edit.click();
    await expect(page.locator('#structure-geometry-editor').locator('.on-map-editor__panel')).toBeVisible();
    await expect(page.locator('#structure-geometry-editor [data-action="save"]')).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).proposalDraftStore.getActiveDraft()?.sourceProposalId)).toBeTruthy();
  });

  test('Solana mint success View opens the devnet transaction explorer', async ({ mockApi: page }) => {
    await injectMockSolanaWallet(page, { publicKey: SOLANA_WALLET, providerName: 'phantom' });
    await installProposalBlockGround(page);
    await page.route('**/ipfs/upload', route => route.fulfill({ json: {
      metadataUri: 'ipfs://sixth-pass-solana-metadata',
      metadataGatewayUrl: 'https://gateway.invalid/sixth-pass-solana-metadata.json',
      imageUri: 'ipfs://sixth-pass-solana-image',
    } }));
    await page.route('**/metadata', route => route.fulfill({ json: {
      metadataUrl: 'ipfs://sixth-pass-parcel-anchor-metadata',
    } }));
    await openCity(page);
    await establishLocalProfile(page);
    await connectWalletByConnectorId(page, 'solana-phantom');
    await waitForBlockchainRuntime(page, ['SolanaProposalChainBridge', 'SolanaChainDataLoader', 'LensPicker', 'LensCore']);
    await installSolanaExternalBoundary(page, { parcelIds: BLOCK_PARCEL_IDS });
    await page.evaluate(wallet => (window as any).LensPicker.setEntries([{ address: wallet }]), SOLANA_WALLET);
    await openFreshProposalFromBlock(page);
    const create = page.locator('.create-proposal-modal:visible');
    await create.locator('#proposalName').fill('Solana explorer button test');
    await create.locator('#proposalDescription').fill('A bounded devnet transaction explorer test.');
    await create.locator('label.proposal-radio:has(input[name="proposalLandUse"][value="park"])').click();
    await chooseProposalKind(create, 'owner-deal');
    await create.locator('#proposalOptionsSection > .collapsible-header').click();
    await create.locator('#proposalOffer').fill('100');
    await create.locator('#createProposalSubmitButton').click();
    const prerequisite = page.locator('.cb-dialog-overlay--confirm');
    await expect(prerequisite).toContainText('no parcel anchor');
    await prerequisite.getByRole('button', { name: 'Create the parcel anchors', exact: true }).click();
    const anchorModal = page.locator('#parcel-mint-modal-overlay');
    await expect(anchorModal).toBeVisible();
    await anchorModal.getByRole('button', { name: 'Mint', exact: true }).click();
    await expect(page.locator('#parcel-mint-success-modal')).toContainText('parcels have been minted!');
    await page.locator('#parcel-mint-success-modal').getByRole('button', { name: 'OK', exact: true }).click();
    await expect(anchorModal).toBeHidden();
    await create.locator('#createProposalSubmitButton').click();
    const success = page.locator('#proposal-mint-success-modal');
    await expect(success).toContainText('has been minted!', { timeout: 30000 });

    await page.context().route('https://explorer.solana.com/**', route => route.fulfill({
      status: 200, contentType: 'text/html', body: '<title>Solana explorer boundary</title>',
    }));
    const popupPromise = page.waitForEvent('popup');
    const popupHandling = popupPromise.then(async popup => {
      await expect.poll(() => popup.url()).toBe('https://explorer.solana.com/tx/5N2o4X1mockSignature?cluster=devnet');
      await popup.close();
    });
    await Promise.all([
      success.getByRole('button', { name: 'View on Solana Explorer', exact: true }).click({ noWaitAfter: true }),
      popupHandling,
    ]);
    await success.getByRole('button', { name: 'OK', exact: true }).click();
    await expect(success).toBeHidden();
  });

  test('local proposal list Sync blockchain performs contract reads through the wallet boundary', async ({ mockApi: page }) => {
    await injectMockEvmWallet(page, { account: EVM_WALLET, chainIdHex: '0x14a34', walletKind: 'metamask' });
    await openCity(page);
    await connectWalletByConnectorId(page, 'metamask');
    await waitForBlockchainRuntime(page, ['ChainDataLoader', 'BlockchainSync', 'ethers']);
    await installProposalEvmBoundary(page);
    await page.locator('#proposals-button').click();
    const list = page.locator('#proposals-sheet .proposal-list-modal');
    await expect.poll(() => page.evaluate(() => Boolean((window as any).walletManager?.getProvider?.()))).toBe(true);
    const filtersToggle = list.locator('.proposal-filters-toggle');
    await filtersToggle.click();
    await expect(filtersToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(list.locator('#sync-blockchain-proposals-btn')).toBeVisible();
    const ethCallsBefore = await page.evaluate(() => (window as any).__proposalEvmBoundary.filter((method: string) => method === 'eth_call').length);
    await list.locator('#sync-blockchain-proposals-btn').click();
    await expect.poll(() => page.evaluate(() => (window as any).__proposalEvmBoundary.filter((method: string) => method === 'eth_call').length)).toBeGreaterThan(ethCallsBefore);
  });

  test('proposal list Buy executes an open ownership offer from its row action', async ({ mockApi: page }) => {
    await openCity(page);
    await establishLocalProfile(page);
    const proposalId = await page.evaluate(({ parcelId, geometry }) => (window as any).proposalStorage.addProposal({
      proposalId: 'list-buy-owner-offer', title: 'List purchase action', goal: 'parcelBased', lifecycleStatus: 'Active',
      offer: 100, cadastreParcelIds: [parcelId], geometry, facets: { ownership: 'third-party' },
      ownershipTransferProposal: { direction: 'from-me', recipientScope: 'any', status: 'open' },
    }), { parcelId: PARCEL_ID, geometry: PARCEL_GEOMETRY });
    await page.locator('#proposals-button').click();
    const row = page.locator(`#proposals-sheet .proposal-list-item[data-proposal-id="${proposalId}"]`);
    const buy = row.locator('.proposal-buy-btn');
    await expect(buy).toBeVisible();
    await buy.click();
    await expect.poll(() => page.evaluate(id => (window as any).proposalStorage.getProposal(id)?.lifecycleStatus, proposalId)).toBe('Executed');
    await expect(row.locator('.proposal-buy-btn')).toHaveCount(0);
  });

  test('the owner-row Vote yes and Rescind controls update the vote record', async ({ mockApi: page }) => {
    // The register (parcel-ownership/1) names owners only; the owner's wallet comes from the
    // single-owner chain-address hook the parcel panel consults.
    const ownerWallet = (wallet: string) => { (window as any).fetchParcelNftOwnerAddress = async () => wallet; };
    await page.addInitScript(ownerWallet, SOLANA_WALLET);
    await page.evaluate(ownerWallet, SOLANA_WALLET);
    await page.route('**/parcel-ownership/**', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ contract: 'parcel-ownership/1', owners: [{ name: 'Fixture voter', shareText: '1/1', sharePercent: 100, ownerType: 'private individual' }] }),
    }));
    await openCity(page);
    await establishLocalProfile(page);
    await openParcel(page, 'info');
    await page.waitForFunction(parcelId => {
      const slots = (window as any).getParcelOwnerSlots?.(parcelId);
      return Array.isArray(slots) && slots.length > 0 && slots.every((slot: any) => !slot.placeholder);
    }, PARCEL_ID);
    const proposalId = await page.evaluate(({ parcelId, geometry }) => {
      const w = window as any;
      const owners = w.getOwnerSlotsForParcel(parcelId);
      const ownerOrder = owners.map((slot: any) => slot.key);
      return w.proposalStorage.addProposal({
        title: 'Vote and rescind controls', goal: 'park', lifecycleStatus: 'Active', cadastreParcelIds: [parcelId], geometry,
        facets: { ownership: 'no-change', parcels: 'as-is' }, kind: 'owner-vote', termsConfirmed: true,
        ownerAcceptances: { [parcelId]: { owners: Object.fromEntries(owners.map((slot: any) => [slot.key, slot])), ownerOrder, acceptedOwnerKeys: [], acceptedBy: {} } },
      });
    }, { parcelId: PARCEL_ID, geometry: PARCEL_GEOMETRY });
    await showProposal(page, proposalId);
    const panel = page.locator('#proposal-details-panel');
    const expand = panel.getByRole('button', { name: 'Expand', exact: true });
    if (await expand.isVisible()) await expand.click();
    const land = page.locator('#proposal-details-content details[data-proposal-section="land"]');
    if (!(await land.evaluate(element => (element as HTMLDetailsElement).open))) await land.locator(':scope > summary').click();
    const owner = land.locator('.owner-acceptance-row').first();
    const voteYes = owner.getByRole('button', { name: 'Vote yes', exact: true });
    await expect(voteYes).toBeVisible();
    await voteYes.click();
    await expect.poll(() => page.evaluate(({ id, parcelId }) => (window as any).proposalStorage.getProposal(id)?.ownerAcceptances[parcelId]?.acceptedOwnerKeys?.length, { id: proposalId, parcelId: PARCEL_ID })).toBeGreaterThan(0);
    const rescind = owner.getByRole('button', { name: 'Rescind', exact: true });
    await expect(rescind).toBeVisible();
    await rescind.click();
    await expect.poll(() => page.evaluate(({ id, parcelId }) => (window as any).proposalStorage.getProposal(id)?.ownerAcceptances[parcelId]?.acceptedOwnerKeys?.length, { id: proposalId, parcelId: PARCEL_ID })).toBe(0);
  });

  test('Accept ownership transfer Fund submits and dismisses its confirmation dialog', async ({ mockApi: page }) => {
    await openCity(page);
    const proposalId = await page.evaluate(({ parcelId, geometry }) => (window as any).proposalStorage.addProposal({
      proposalId: 'accept-transfer-submit-control', title: 'Accept transfer submission', goal: 'ownership-transfer-from-me',
      lifecycleStatus: 'Active', offer: 100, cadastreParcelIds: [parcelId], geometry,
      ownershipTransferProposal: { direction: 'from-me', recipientScope: 'any', status: 'open' },
    }), { parcelId: PARCEL_ID, geometry: PARCEL_GEOMETRY });
    await showProposal(page, proposalId);
    const panel = page.locator('#proposal-details-panel');
    const expand = panel.getByRole('button', { name: 'Expand', exact: true });
    if (await expand.isVisible()) await expand.click();
    const funding = page.locator('#proposal-details-content details[data-proposal-section="funding"]');
    if (!(await funding.evaluate(element => (element as HTMLDetailsElement).open))) await funding.locator(':scope > summary').click();
    await funding.locator('.offer-boost-button[aria-label="Accept ownership transfer"]').click();
    const dialog = page.locator('#acceptOwnershipTransferOverlay');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Fund', exact: true }).click();
    await expect(dialog).toBeHidden();
  });

  test('Open bet from the proposal market opens the transaction-backed bet dialog', async ({ mockApi: page }) => {
    await injectMockSolanaWallet(page, { publicKey: SOLANA_WALLET, providerName: 'phantom' });
    await openCity(page);
    await page.evaluate(() => (window as any).i18n.setLanguage('en'));
    await connectWalletByConnectorId(page, 'solana-phantom');
    await waitForBlockchainRuntime(page, ['SolanaMarketClient', 'SolanaChainDataLoader']);
    await installMarketRpcFixture(page);
    const proposalId = await page.evaluate(({ parcelId }) => (window as any).proposalStorage.addProposal({
      title: 'Open bet action', goal: 'park', lifecycleStatus: 'Active', cadastreParcelIds: [parcelId], isMinted: true,
      nft: { chain: 'solana-devnet', contract: '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg', tokenId: '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg' },
    }), { parcelId: PARCEL_ID });
    await showProposal(page, proposalId);
    const panel = page.locator('#proposal-details-panel');
    const expand = panel.getByRole('button', { name: 'Expand', exact: true });
    if (await expand.isVisible()) await expand.click();
    const market = panel.locator('details[data-proposal-section="market"]');
    if (!(await market.evaluate(element => (element as HTMLDetailsElement).open))) await market.locator(':scope > summary').click();
    const openBet = market.locator('.proposal-market-open');
    await expect(openBet).toBeVisible();
    await openBet.click();
    const bet = page.locator('#proposalMarketOverlay');
    await expect(bet).toBeVisible();
    await expect(bet).toContainText('Bet on cities');
    await bet.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(bet).toBeHidden();
  });

  test('Connect Solana in the proposal market opens the wallet picker', async ({ mockApi: page }) => {
    await injectMockSolanaWallet(page, { publicKey: SOLANA_WALLET, providerName: 'phantom' });
    await openCity(page);
    await page.evaluate(() => (window as any).i18n.setLanguage('en'));
    await waitForBlockchainRuntime(page, ['SolanaMarketClient', 'SolanaChainDataLoader']);
    await installMarketRpcFixture(page, true, false);
    const proposalId = await page.evaluate(({ parcelId, proposalAccount }) => (window as any).proposalStorage.addProposal({
      title: 'Connect market wallet action', goal: 'park', lifecycleStatus: 'Active', cadastreParcelIds: [parcelId], isMinted: true,
      nft: { chain: 'solana-devnet', contract: proposalAccount, tokenId: proposalAccount },
    }), { parcelId: PARCEL_ID, proposalAccount: PROPOSAL_ACCOUNT });
    await showProposal(page, proposalId);
    const market = page.locator('#proposal-details-panel .proposal-market-summary');
    const panel = page.locator('#proposal-details-panel');
    const expand = panel.getByRole('button', { name: 'Expand', exact: true });
    if (await expand.isVisible()) await expand.click();
    const marketSection = panel.locator('details[data-proposal-section="market"]');
    if (!(await marketSection.evaluate(element => (element as HTMLDetailsElement).open))) await marketSection.locator(':scope > summary').click();
    const connect = market.getByRole('button', { name: 'Connect Solana wallet', exact: true });
    await expect(connect).toBeVisible();
    await connect.click();
    await expect(page.locator('.wallet-modal-overlay')).toBeVisible();
    await expect(page.locator('[data-wallet-options]')).toBeVisible();
  });

  test('Lens Submit verdict validates a malformed attestation in the real ownership card', async ({ mockApi: page }) => {
    await openCity(page);
    const proposalId = await page.evaluate(({ parcelId, proposalAccount, lensMember }) => (window as any).proposalStorage.addProposal({
      title: 'Lens verdict validation', goal: 'park', lifecycleStatus: 'Active', cadastreParcelIds: [parcelId], isMinted: true,
      nft: { chain: 'solana-devnet', contract: proposalAccount, tokenId: proposalAccount }, lens: [lensMember],
    }), { parcelId: PARCEL_ID, proposalAccount: PROPOSAL_ACCOUNT, lensMember: SOLANA_WALLET });
    await showProposal(page, proposalId);
    const panel = page.locator('#proposal-details-panel');
    const expand = panel.getByRole('button', { name: 'Expand', exact: true });
    if (await expand.isVisible()) await expand.click();
    const verification = page.locator('#proposal-details-content details[data-proposal-section="verification"]');
    if (!(await verification.evaluate(element => (element as HTMLDetailsElement).open))) await verification.locator(':scope > summary').click();
    const submit = page.locator(`.proposal-lens-card[data-proposal-lens-card="${PROPOSAL_ACCOUNT}"] [data-lens-submit-verdict]`);
    await expect(submit).toBeVisible();
    const input = page.locator(`.proposal-lens-card[data-proposal-lens-card="${PROPOSAL_ACCOUNT}"] [data-lens-verdict-address]`);
    await input.fill('not-a-solana-attestation');
    await submit.click();
    await expect(page.locator(`.proposal-lens-card[data-proposal-lens-card="${PROPOSAL_ACCOUNT}"] [data-lens-verdict-result]`)).toContainText(/valid|address|attestation/i);
  });

  test('Open the pool submits the market creation transaction through the wallet boundary', async ({ mockApi: page }) => {
    await injectMockSolanaWallet(page, { publicKey: SOLANA_WALLET, providerName: 'phantom' });
    await openCity(page);
    await page.evaluate(() => (window as any).i18n.setLanguage('en'));
    await connectWalletByConnectorId(page, 'solana-phantom');
    await waitForBlockchainRuntime(page, ['SolanaMarketClient', 'SolanaChainDataLoader']);
    await installMarketRpcFixture(page, false);
    const proposalId = await page.evaluate(({ parcelId, proposalAccount }) => (window as any).proposalStorage.addProposal({
      title: 'Open pool action', goal: 'park', lifecycleStatus: 'Active', cadastreParcelIds: [parcelId], isMinted: true,
      nft: { chain: 'solana-devnet', contract: proposalAccount, tokenId: proposalAccount },
    }), { parcelId: PARCEL_ID, proposalAccount: PROPOSAL_ACCOUNT });
    await showProposal(page, proposalId);
    const panel = page.locator('#proposal-details-panel');
    const expand = panel.getByRole('button', { name: 'Expand', exact: true });
    if (await expand.isVisible()) await expand.click();
    const market = panel.locator('details[data-proposal-section="market"]');
    if (!(await market.evaluate(element => (element as HTMLDetailsElement).open))) await market.locator(':scope > summary').click();
    const openPool = market.getByRole('button', { name: 'Open the pool', exact: true });
    await expect(openPool).toBeVisible();
    await openPool.click();
    await expect.poll(() => page.evaluate(() => (window as any).__proposalMarketRpcEvents)).toContain('confirm');
    await expect.poll(() => page.evaluate(() => (window as any).__proposalMarketSignedInstructionData))
      .toContainEqual([103, 226, 97, 235, 200, 188, 251, 254]); // create_market
  });

  test('Settle from proposal status submits the market resolution transaction', async ({ mockApi: page }) => {
    await injectMockSolanaWallet(page, { publicKey: SOLANA_WALLET, providerName: 'phantom' });
    await openCity(page);
    await page.evaluate(() => (window as any).i18n.setLanguage('en'));
    await connectWalletByConnectorId(page, 'solana-phantom');
    await waitForBlockchainRuntime(page, ['SolanaMarketClient', 'SolanaChainDataLoader']);
    await installMarketRpcFixture(page);
    const proposalId = await page.evaluate(({ parcelId, proposalAccount }) => (window as any).proposalStorage.addProposal({
      title: 'Settle pool action', goal: 'park', lifecycleStatus: 'Executed', cadastreParcelIds: [parcelId], isMinted: true,
      nft: { chain: 'solana-devnet', contract: proposalAccount, tokenId: proposalAccount },
    }), { parcelId: PARCEL_ID, proposalAccount: PROPOSAL_ACCOUNT });
    await showProposal(page, proposalId);
    const panel = page.locator('#proposal-details-panel');
    const expand = panel.getByRole('button', { name: 'Expand', exact: true });
    if (await expand.isVisible()) await expand.click();
    const market = panel.locator('details[data-proposal-section="market"]');
    if (!(await market.evaluate(element => (element as HTMLDetailsElement).open))) await market.locator(':scope > summary').click();
    const settle = market.getByRole('button', { name: /Settle yes from the proposal's status/i });
    await expect(settle).toBeVisible();
    await settle.click();
    await expect.poll(() => page.evaluate(() => (window as any).__proposalMarketRpcEvents)).toContain('confirm');
    await expect.poll(() => page.evaluate(() => (window as any).__proposalMarketSignedInstructionData))
      .toContainEqual([246, 150, 236, 206, 108, 63, 58, 10]); // resolve
  });

  test('lens editor Add creates a real address row and Close saves the cleaned list', async ({ mockApi: page }) => {
    await openCity(page);
    const proposalId = await createSpace(page, 'park');
    await showProposal(page, proposalId);
    await page.locator('#proposal-details-footer .btn-counterpropose-proposal').click();
    const create = page.locator('.create-proposal-modal:visible');
    await expect(create).toBeVisible();
    await create.locator('[data-lens-pattern]').click();
    const lens = page.locator('.lens-modal-overlay');
    await expect(lens).toBeVisible();
    const addressRows = lens.locator('.lens-address-input');
    const before = await addressRows.count();
    await lens.locator('#lens-add-btn').click();
    await expect(addressRows).toHaveCount(before + 1);
    await addressRows.last().fill('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
    await lens.locator('.lens-close-btn').click();
    await expect(lens).toBeHidden();
    await expect.poll(() => page.evaluate(() => (window as any).getLensEntries?.().some((entry: any) => entry.address === '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'))).toBe(true);
  });

  test('ownership offer lens Close and Submit use the live attestation and form flow', async ({ mockApi: page }) => {
    await injectMockSolanaWallet(page, { publicKey: SOLANA_WALLET, providerName: 'phantom' });
    await page.route('**/lenses/members', route => route.fulfill({ json: { members: [
      { key: PROPOSAL_ACCOUNT, name: 'Fixture owner attester', serviceUrl: 'https://lens-fixture.test' },
    ] } }));
    await page.route('**/lens/attestations?*', route => {
      const url = new URL(route.request().url());
      return route.fulfill({ json: { attestations: [{
        address: 'fixture-attestation', kind: 'ownership', authority: PROPOSAL_ACCOUNT,
        parcelUid: url.searchParams.get('parcelUid'), owner: SOLANA_WALLET,
      }] } });
    });
    await openCity(page);
    await establishLocalProfile(page);
    await connectWalletByConnectorId(page, 'solana-phantom');
    await waitForBlockchainRuntime(page, ['LensPicker', 'LensCore', 'LensServiceClient']);
    await page.evaluate(member => (window as any).LensPicker.setEntries([{ address: member, name: 'Fixture owner attester' }]), PROPOSAL_ACCOUNT);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-build-btn--offer').click();
    const create = page.locator('.create-proposal-modal:visible');
    await expect(create).toBeVisible();
    await expect(create.locator('#proposalOwnerOfferCheckbox')).toBeChecked();
    await create.locator('[data-lens-pattern]').click();
    const lens = page.locator('.lens-modal-overlay');
    await expect(lens).toBeVisible();
    await lens.locator('.lens-close-btn').click();
    await expect(lens).toBeHidden();
    await create.locator('.proposal-modal-close').click();
    await expect(create).toBeHidden();
    await page.locator('.parcel-build-btn--offer').click();
    const resubmitted = page.locator('.create-proposal-modal:visible');
    await expect(resubmitted.locator('#proposalOwnerOfferCheckbox')).toBeChecked();
    await resubmitted.locator('#proposalOptionsSection > .collapsible-header').click();
    await resubmitted.locator('#proposalOffer').fill('0');
    await resubmitted.locator('#createProposalSubmitButton').click();
    await expect(page.locator('.cb-dialog-overlay--confirm')).toContainText('Please enter a valid offer amount.');
    await expect(resubmitted).toBeVisible();
  });

  test('simple shared-link error modal Close action dismisses the modal', async ({ mockApi: page }) => {
    await page.goto('/?city=zg&reduceMotion=1&proposalShare=not-a-valid-share-payload', { waitUntil: 'domcontentloaded' });
    await page.locator('.leaflet-container').waitFor();
    const modal = page.locator('.share-modal-overlay');
    await expect(modal).toContainText(/Invalid share link/i);
    await modal.locator('.share-modal .cb-dialog__footer .btn-primary').click();
    await expect(modal).toBeHidden();
  });

  test('Upload share modal blocks minting an unsupported approval setup', async ({ mockApi: page }) => {
    const server = createSharedProposalServer();
    await attachSharedProposalServer(page, server);
    await injectMockEvmWallet(page, { account: EVM_WALLET, chainIdHex: '0x14a34', walletKind: 'metamask' });
    await openCity(page);
    await connectWalletByConnectorId(page, 'metamask');
    await establishLocalProfile(page);
    const proposalId = await createSpace(page, 'park');
    await page.evaluate(id => {
      const proposal = (window as any).proposalStorage.getProposal(id);
      proposal.approvalConfig = { schema: 'proposal-approval/v1', rights: null, policy: { type: 'unanimous' } };
      Object.assign(proposal, { kind: 'community-vote', termsConfirmed: true });
      (window as any).proposalStorage.save();
    }, proposalId);
    await showProposal(page, proposalId);
    await page.locator('#proposal-details-footer .btn-share-proposal').click();
    const share = page.locator('.share-modal-overlay');
    await expect(share.getByRole('button', { name: 'Mint', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(id => {
      const proposal = (window as any).proposalStorage.getProposal(id);
      return (window as any).ProposalApprovalRuntime?.uses(proposal) === true
        && (window as any).ProposalChainBridge?.supportsProposalApproval?.('proposal-approval/v1') === false;
    }, proposalId)).toBe(true);
    await share.getByRole('button', { name: 'Mint', exact: true }).click();
    await expect(share.locator('.share-proposal-status')).toContainText('This approval setup is not supported by the current chain adapter.');
    await expect(page.locator('.wallet-modal-overlay')).toHaveCount(0);
    await expect.poll(() => page.evaluate(id => {
      const proposal = (window as any).proposalStorage.getProposal(id);
      return Boolean(proposal?.nft?.tokenId);
    }, proposalId)).toBe(false);
  });

  test('Upload share modal Mint row Connect Wallet opens the picker for a legacy parcel proposal', async ({ mockApi: page }) => {
    const server = createSharedProposalServer();
    await attachSharedProposalServer(page, server);
    await openCity(page);
    await establishLocalProfile(page);
    const proposalId = await page.evaluate(({ parcelId, geometry }) => (window as any).proposalStorage.addProposal({
      proposalId: 'legacy-share-wallet-picker', title: 'Legacy wallet picker proposal',
      description: 'A parcel proposal without abstract approval configuration.',
      goal: 'park', lifecycleStatus: 'Active', city: 'zagreb', cadastreParcelIds: [parcelId], geometry,
      kind: 'community-vote', termsConfirmed: true,
      structureProposal: { kind: 'park', geometry, applied: true },
      lens: [{ address: '0x1234567890123456789012345678901234567890' }],
    }), { parcelId: PARCEL_ID, geometry: PARCEL_GEOMETRY });
    await expect.poll(() => page.evaluate(id => (window as any).ProposalApprovalRuntime.uses(
      (window as any).proposalStorage.getProposal(id),
    ), proposalId)).toBe(false);
    await showProposal(page, proposalId);
    await page.locator('#proposal-details-footer .btn-share-proposal').click();
    const share = page.locator('.share-modal-overlay');
    const connect = share.getByRole('button', { name: /Connect wallet/i });
    await expect(connect).toBeVisible();
    await expect(connect).toBeEnabled();
    await connect.click();
    await expect(page.locator('.wallet-modal-overlay')).toBeVisible();
    await expect(page.locator('[data-wallet-options]')).toBeVisible();
  });

  test('proposal sharing Upload exposes copyable link and Close dismisses the uploaded share dialog', async ({ mockApi: page }) => {
    const server = createSharedProposalServer();
    await attachSharedProposalServer(page, server);
    await openCity(page);
    await establishLocalProfile(page);
    const proposalId = await createSpace(page, 'park');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
    await showProposal(page, proposalId);
    await page.locator('#proposal-details-footer .btn-share-proposal').click();
    await chooseTermsForShare(page);
    const modal = page.locator('.share-modal-overlay');
    await modal.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(modal.locator('.share-modal-share-actions')).toBeVisible();
    const url = await modal.locator('.share-modal-link').first().inputValue();
    await modal.getByRole('button', { name: 'Copy URL', exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(url);
    await modal.locator('.share-modal .close-circle-btn').click();
    await expect(modal).toBeHidden();
  });
});
