import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, proposalState, showProposal, PARCEL_ID } from '../helpers/runtime';
import { connectWalletByConnectorId, injectMockSolanaWallet, stubSolanaBridgeSuccess, waitForBlockchainRuntime } from '../helpers/blockchain';

const SOLANA_WALLET = '7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT';
const PROPOSAL_ACCOUNT = '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg';
const PARCEL_PROGRAM = '4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1';

async function establishLocalProfile(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('#username-display').click();
  await expect(page.locator('#welcome-modal')).toBeVisible();
  await page.locator('#username-input').fill('Parcel Owner');
  await page.locator('#welcome-submit-btn').click();
  await expect(page.locator('#welcome-modal')).toBeHidden();
}

async function loadParcelOwnershipFixture(page: import('@playwright/test').Page): Promise<void> {
  await page.route(`**/parcels/${encodeURIComponent(PARCEL_ID)}/ownership`, route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ owners: [{ name: 'Fixture private owner', ownership: '1/1', address: SOLANA_WALLET }] }),
  }));
  await openParcel(page, 'info');
  await page.waitForFunction(parcelId => {
    const slots = (window as any).getParcelOwnerSlots?.(parcelId);
    return Array.isArray(slots) && slots.length > 0 && slots.every((slot: any) => !slot.placeholder);
  }, PARCEL_ID);
}

async function chooseLocalProposal(page: import('@playwright/test').Page): Promise<void> {
  const confirm = page.locator('.cb-confirm-overlay');
  await expect(confirm).toContainText('Proceed to create an in-memory proposal?');
  const inMemoryButton = confirm.getByRole('button', { name: 'Create in memory', exact: true });
  if (await inMemoryButton.count()) await inMemoryButton.click();
  else await confirm.getByRole('button', { name: 'Create', exact: true }).click();
}

async function installMarketRpcFixture(page: import('@playwright/test').Page, resolved: boolean): Promise<void> {
  await page.evaluate(({ proposal, wallet, resolved: marketResolved }) => {
    const w = window as any;
    const client = w.SolanaMarketClient;
    const web3 = w.solanaWeb3;
    const proposalKey = new web3.PublicKey(proposal);
    const walletKey = new web3.PublicKey(wallet);
    const mintKey = new web3.PublicKey(client.DEVNET_USDC_MINT || '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
    const [marketPda] = client.getMarketPda(proposalKey);
    const [yesPosition] = client.getPositionPda(marketPda, walletKey, client.constants.SIDE_YES);
    const [noPosition] = client.getPositionPda(marketPda, walletKey, client.constants.SIDE_NO);
    const marketBytes = new Uint8Array(client.MARKET_SIZE);
    let offset = 0;
    const put = (bytes: Uint8Array) => { marketBytes.set(bytes, offset); offset += bytes.length; };
    // Anchor account discriminator for Market from the deployed IDL; account bytes below follow
    // Market's Borsh field order, so the production decoder still validates the RPC fixture.
    put(Uint8Array.from([219, 190, 213, 55, 0, 227, 198, 154]));
    put(proposalKey.toBytes()); put(mintKey.toBytes()); put(new Uint8Array(32));
    const writeU64 = (value: bigint) => { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, value, true); put(bytes); };
    writeU64(4_000_000n); writeU64(2_000_000n);
    put(Uint8Array.of(marketResolved ? 1 : 0, 1, 1));

    const positionBytes = new Uint8Array(client.POSITION_SIZE);
    offset = 0;
    const writePosition = (bytes: Uint8Array) => { positionBytes.set(bytes, offset); offset += bytes.length; };
    writePosition(Uint8Array.from([170, 188, 143, 228, 122, 64, 247, 208]));
    writePosition(marketPda.toBytes()); writePosition(walletKey.toBytes());
    writePosition(Uint8Array.of(1));
    const amount = new Uint8Array(8); new DataView(amount.buffer).setBigUint64(0, 1_000_000n, true); writePosition(amount);
    writePosition(Uint8Array.of(0, 1));

    const accounts = new Map<string, Uint8Array>([
      [marketPda.toBase58(), marketBytes],
      [yesPosition.toBase58(), positionBytes],
    ]);
    const events: string[] = [];
    const connection = {
      getAccountInfo: async (key: any) => {
        const data = accounts.get(key.toBase58());
        return data ? { data, owner: new web3.PublicKey(client.constants.PROGRAM_ID) } : null;
      },
      getBalance: async () => 2_000_000_000,
      getTokenAccountBalance: async () => ({ value: { amount: '50000000', decimals: 6 } }),
      getLatestBlockhash: async () => ({ blockhash: 'EkSnNWid2cvwEVnVx9aBqpiCpY1QoUW63D2Hp31e4gwJ', lastValidBlockHeight: 99 }),
      simulateTransaction: async () => ({ value: { err: null, logs: [] } }),
      sendRawTransaction: async () => { events.push('send'); return '5N2o4X1mockSignature'; },
      confirmTransaction: async () => { events.push('confirm'); return { value: { err: null } }; },
    };
    const provider = w.solanaWalletManager?.getProvider?.();
    if (!provider) throw new Error('Connected Solana provider is unavailable');
    provider.signTransaction = async (transaction: any) => {
      w.__proposalMarketSignedInstructionData = (transaction.instructions || []).map((instruction: any) => Array.from(instruction.data || []));
      transaction.serialize = () => new Uint8Array([1, 2, 3]);
      return transaction;
    };
    w.__proposalMarketRpcEvents = events;
    w.SolanaChainDataLoader.getConnection = () => connection;
  }, { proposal: PROPOSAL_ACCOUNT, wallet: SOLANA_WALLET, resolved });
}

async function expandProposalDetails(page: import('@playwright/test').Page): Promise<void> {
  const expand = page.locator('#proposal-details-panel').getByRole('button', { name: 'Expand', exact: true });
  if (await expand.isVisible()) await expand.click();
}

test.describe('Proposal actions @features', () => {
  test('parcel owner can accept and then withdraw an unexecuted proposal from its details panel', async ({ mockApi: page }) => {
    await openCity(page);
    await establishLocalProfile(page);
    await loadParcelOwnershipFixture(page);
    const proposalId = await page.evaluate((parcelId) => {
      const w = window as any;
      const owners = w.getOwnerSlotsForParcel(parcelId);
      if (!owners?.length) throw new Error('Parcel owner slot resolver returned no owner slots');
      const ownerOrder = owners.map((slot: any) => slot.key);
      const canonicalOwners = Object.fromEntries(owners.map((slot: any) => [slot.key, slot]));
      return w.proposalStorage.addProposal({
        title: 'Owner consent action',
        goal: 'parcelBased',
        lifecycleStatus: 'Active',
        funded: true,
        cadastreParcelIds: [parcelId],
        ownerAcceptances: {
          [parcelId]: {
            owners: canonicalOwners,
            ownerOrder,
            acceptedOwnerKeys: [],
            acceptedBy: {},
          },
        },
      });
    }, PARCEL_ID);
    await showProposal(page, proposalId);
    await expandProposalDetails(page);

    const ownShare = page.locator('.owner-acceptance-row').first();
    const ownerKey = await page.evaluate(parcelId => (window as any).getOwnerSlotsForParcel(parcelId)[0].key, PARCEL_ID);
    await expect(ownShare.getByRole('button', { name: 'Accept' })).toBeVisible();
    await ownShare.getByRole('button', { name: 'Accept' }).click();
    await expect.poll(async () => (await proposalState(page, proposalId)).ownerAcceptances[PARCEL_ID].acceptedOwnerKeys)
      .toContain(ownerKey);
    await expect(ownShare.getByRole('button', { name: 'Undo' })).toBeVisible();

    await ownShare.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => (await proposalState(page, proposalId)).ownerAcceptances[PARCEL_ID].acceptedOwnerKeys)
      .not.toContain(ownerKey);
    expect((await proposalState(page, proposalId)).lifecycleStatus).toBe('Active');
  });

  test('final parcel acceptance executes the proposal and records the completed lifecycle', async ({ mockApi: page }) => {
    await openCity(page);
    await establishLocalProfile(page);
    await loadParcelOwnershipFixture(page);
    const proposalId = await page.evaluate((parcelId) => (window as any).proposalStorage.addProposal({
      title: 'Single owner execution',
      goal: 'parcelBased',
      lifecycleStatus: 'Active',
      funded: true,
      offer: 0,
      cadastreParcelIds: [parcelId],
    }), PARCEL_ID);
    await showProposal(page, proposalId);
    await expandProposalDetails(page);

    const ownerRow = page.locator('.owner-acceptance-row').first();
    await expect(ownerRow.getByRole('button', { name: 'Accept' })).toBeVisible();
    await ownerRow.getByRole('button', { name: 'Accept' }).click();

    await expect.poll(async () => (await proposalState(page, proposalId)).lifecycleStatus).toBe('Executed');
    const executed = await proposalState(page, proposalId);
    expect(executed.acceptedParcelIds).toContain(PARCEL_ID);
    expect(executed.executedAt).toBeTruthy();
  });

  test('minted proposal support opens the donation dialog and confirms the mocked chain transaction', async ({ mockApi: page }) => {
    await injectMockSolanaWallet(page, { publicKey: SOLANA_WALLET, providerName: 'phantom' });
    await openCity(page);
    await connectWalletByConnectorId(page, 'solana-phantom');
    await waitForBlockchainRuntime(page, ['SolanaPledgeBridge', 'SolanaPledgeClient', 'SolanaChainDataLoader', 'solanaWeb3']);

    // Only the RPC boundary is replaced: the UI, support bridge and instruction builder remain real.
    await page.evaluate(() => {
      const w = window as any;
      const events: string[] = [];
      const connection = {
        getAccountInfo: async () => null,
        getBalance: async () => 2_000_000_000,
        getTokenAccountBalance: async () => ({ value: { amount: '50000000', decimals: 6 } }),
        getLatestBlockhash: async () => ({ blockhash: 'EkSnNWid2cvwEVnVx9aBqpiCpY1QoUW63D2Hp31e4gwJ', lastValidBlockHeight: 99 }),
        sendRawTransaction: async () => { events.push('send'); return '5N2o4X1mockSignature'; },
        confirmTransaction: async () => { events.push('confirm'); return { value: { err: null } }; },
        simulateTransaction: async () => ({ value: { err: null, logs: [] } }),
        getProgramAccounts: async () => [],
        getMultipleAccountsInfo: async () => [],
        getSignaturesForAddress: async () => [],
      };
      w.__proposalActionChainEvents = events;
      const provider = w.solanaWalletManager?.getProvider?.();
      if (!provider) throw new Error('Connected Solana provider is unavailable');
      provider.signTransaction = async (transaction: any) => {
        transaction.serialize = () => new Uint8Array([1, 2, 3]);
        return transaction;
      };
      w.SolanaChainDataLoader.getConnection = () => connection;
    });

    const proposalId = await page.evaluate((data) => (window as any).proposalStorage.addProposal({
      title: 'Fundable proposal',
      goal: 'park',
      lifecycleStatus: 'Active',
      cadastreParcelIds: [data.parcelId],
      isMinted: true,
      nft: { chain: 'solana-devnet', contract: data.programId, tokenId: data.account },
      lens: [data.member],
    }), { parcelId: PARCEL_ID, programId: PROPOSAL_ACCOUNT, account: SOLANA_WALLET, member: PROPOSAL_ACCOUNT });
    await showProposal(page, proposalId);

    await page.locator('.btn-donate-proposal').click();
    const dialog = page.locator('#proposalBoostOverlay');
    await expect(dialog).toBeVisible();
    await dialog.locator('#proposalBoostAmount').fill('1.25');
    await dialog.locator('[data-support-submit]').click();

    await expect(dialog).toBeHidden();
    const confirmation = page.locator('.cb-confirm-overlay');
    await expect(confirmation).toContainText('Success! Thank you for boosting this proposal with 1.25 of USDC.');
    const chainEvents = await page.evaluate(() => (window as any).__proposalActionChainEvents as string[]);
    expect(chainEvents).toContain('send');
    expect(chainEvents).toContain('confirm');
    await confirmation.getByRole('button', { name: 'OK' }).click();
  });

  test('Offer my land proves wallet ownership and creates an owner-offer proposal', async ({ mockApi: page }) => {
    await page.route('**/lenses/members', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ members: [{ key: PROPOSAL_ACCOUNT, name: 'Parcel Lens', serviceUrl: 'https://lens-e2e.invalid' }] }),
    }));
    await page.route('https://lens-e2e.invalid/lens/attestations**', async route => {
      const url = new URL(route.request().url());
      const parcelUid = url.searchParams.get('parcelUid');
      const owner = url.searchParams.get('owner');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ attestations: [{
          address: '8opHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKh',
          kind: 'ownership', authority: PROPOSAL_ACCOUNT, parcelUid, owner, expiry: 0,
        }] }),
      });
    });
    await injectMockSolanaWallet(page, { publicKey: SOLANA_WALLET, providerName: 'phantom' });
    await openCity(page);
    await establishLocalProfile(page);
    await connectWalletByConnectorId(page, 'solana-phantom');
    await waitForBlockchainRuntime(page, ['LensPicker', 'LensCore', 'OwnerOffer', 'SolanaMarketClient', 'SolanaChainDataLoader', 'solanaWeb3']);
    await installMarketRpcFixture(page, false);
    await page.evaluate((member) => (window as any).LensPicker.setEntries([{ address: member, name: 'Parcel Lens' }]), PROPOSAL_ACCOUNT);
    await openParcel(page, 'proposals');

    await page.locator('.parcel-build-btn--offer').click();
    const dialog = page.locator('.create-proposal-modal:visible');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('#proposalOwnerOfferStatus')).toContainText('attested owner of 1 of 1', { timeout: 10000 });
    await expect(dialog.locator('#proposalOwnerOfferCheckbox')).toBeEnabled();
    await expect(dialog.locator('#proposalOwnerOfferCheckbox')).toBeChecked();
    await dialog.locator('#proposalName').fill('Verified parcel owner offer');
    await dialog.locator('#proposalDescription').fill('The attested owner offers this parcel for a new community park.');
    await dialog.locator('#proposalOptionsSection > .collapsible-header').click();
    await expect(dialog.locator('#proposalOffer')).toBeVisible();
    await dialog.locator('#proposalOffer').fill('1000');
    await dialog.locator('#createProposalSubmitButton').click();
    await chooseLocalProposal(page);
    await expect(dialog).toBeHidden({ timeout: 10000 });
    await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals()
      .some((proposal: any) => proposal.title === 'Verified parcel owner offer' && proposal.proposalRole === 'owner-offer'))).toBe(true);
    const offer = await page.evaluate(() => (window as any).proposalStorage.getAllProposals()
      .find((proposal: any) => proposal.title === 'Verified parcel owner offer'));
    expect(offer.goal).toBe('ownership-transfer-from-me');
    expect(offer.facets).toMatchObject({ landUse: 'as-is', parcels: 'as-is', ownership: 'third-party' });
    expect(offer.ownershipTransferProposal).toMatchObject({ direction: 'from-me', recipientScope: 'any' });
  });

  test('claim tools keep minting unavailable until a wallet is connected', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'tools');
    const claim = page.locator('#claimButton');
    await expect(claim).toBeVisible();
    await expect(claim).toBeDisabled();
  });

  test('connected parcel owner mints from the parcel tools dialog and receives a confirmed transaction', async ({ mockApi: page }) => {
    await injectMockSolanaWallet(page, { publicKey: SOLANA_WALLET, providerName: 'phantom' });
    await openCity(page);
    await connectWalletByConnectorId(page, 'solana-phantom');
    await waitForBlockchainRuntime(page, ['SolanaChainDataLoader', 'SolanaAcceptanceClient', 'solanaWeb3']);
    await stubSolanaBridgeSuccess(page, { parcelProgramId: PARCEL_PROGRAM, proposalId: 'parcel-token-123' });

    // The metadata service is the app's external asset boundary. RPC instruction creation,
    // wallet signing, sending and confirmation remain on their normal production code paths.
    await page.route('**/metadata', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ metadataUrl: 'ipfs://e2e-parcel-metadata.json' }),
    }));
    await openParcel(page, 'tools');
    const mint = page.locator('#mintAndClaimButton');
    await expect(mint).toBeEnabled();
    await mint.click();
    const mintDialog = page.locator('.parcel-mint-modal');
    await expect(mintDialog).toBeVisible();
    await mintDialog.getByRole('button', { name: 'Mint', exact: true }).click();

    const success = page.locator('#parcel-mint-success-modal');
    await expect(success).toBeVisible({ timeout: 15000 });
    await expect(success).toContainText('Parcel has been minted');
    await expect(success.locator('a[href*="explorer.solana.com/tx/"]')).toBeVisible();
  });

  for (const [side, label, sideValue] of [[1, 'YES', 1], [0, 'NO', 0]] as const) {
    test(`proposal market ${label} stake submits its encoded side and confirms through the visible controls`, async ({ mockApi: page }) => {
    await injectMockSolanaWallet(page, { publicKey: SOLANA_WALLET, providerName: 'phantom' });
    await openCity(page);
    await connectWalletByConnectorId(page, 'solana-phantom');
    await waitForBlockchainRuntime(page, ['SolanaMarketClient', 'SolanaMarketBridge', 'SolanaChainDataLoader', 'solanaWeb3']);
    await installMarketRpcFixture(page, false);
    const proposalId = await page.evaluate((data) => (window as any).proposalStorage.addProposal({
      title: 'Market stake UI proposal', goal: 'park', lifecycleStatus: 'Active', cadastreParcelIds: [data.parcelId],
      isMinted: true, nft: { chain: 'solana-devnet', contract: data.program, tokenId: data.account },
    }), { parcelId: PARCEL_ID, program: PARCEL_PROGRAM, account: PROPOSAL_ACCOUNT });
    await showProposal(page, proposalId);
    await expandProposalDetails(page);

    const market = page.locator('.proposal-market-summary');
    const stakeButton = market.getByRole('button', { name: `Stake ${label}` });
    await expect(stakeButton).toBeVisible({ timeout: 10000 });
    await stakeButton.click();
    const dialog = page.locator('#proposalMarketOverlay');
    await dialog.locator('[data-market-amount]').fill('1');
    await dialog.locator('[data-market-submit]').click();
    await expect(dialog.locator('[data-market-dialog-status]')).toContainText('Confirmed on Solana.', { timeout: 10000 });
    expect(await page.evaluate(() => (window as any).__proposalMarketRpcEvents)).toEqual(['send', 'confirm']);
    const encodedStake = await page.evaluate((expectedSide) => {
      const w = window as any;
      const client = w.SolanaMarketClient;
      const instructions = w.__proposalMarketSignedInstructionData as number[][];
      const discriminator = client.IX_DISCRIMINATORS.stake;
      const instruction = instructions.find(data => discriminator.every((byte: number, index: number) => data[index] === byte));
      return instruction ? instruction[8] : null;
    }, sideValue);
    expect(encodedStake).toBe(side);
  });
  }

  test('a resolved YES position can be claimed from the market card', async ({ mockApi: page }) => {
    await injectMockSolanaWallet(page, { publicKey: SOLANA_WALLET, providerName: 'phantom' });
    await openCity(page);
    await connectWalletByConnectorId(page, 'solana-phantom');
    await waitForBlockchainRuntime(page, ['SolanaMarketClient', 'SolanaMarketBridge', 'SolanaChainDataLoader', 'solanaWeb3']);
    await installMarketRpcFixture(page, true);
    const proposalId = await page.evaluate((data) => (window as any).proposalStorage.addProposal({
      title: 'Market claim UI proposal', goal: 'park', lifecycleStatus: 'Executed', cadastreParcelIds: [data.parcelId],
      isMinted: true, nft: { chain: 'solana-devnet', contract: data.program, tokenId: data.account },
    }), { parcelId: PARCEL_ID, program: PARCEL_PROGRAM, account: PROPOSAL_ACCOUNT });
    await showProposal(page, proposalId);
    await expandProposalDetails(page);

    const market = page.locator('.proposal-market-summary');
    await market.getByRole('button', { name: 'Claim YES' }).click({ timeout: 10000 });
    await expect(market.locator('[data-market="status"]')).toContainText('Confirmed on Solana.', { timeout: 10000 });
    expect(await page.evaluate(() => (window as any).__proposalMarketRpcEvents)).toEqual(['send', 'confirm']);
  });
});
