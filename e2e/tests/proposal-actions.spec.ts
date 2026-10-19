import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, proposalState, showProposal, PARCEL_ID } from '../helpers/runtime';
import { connectWalletByConnectorId, injectMockEvmWallet, injectMockSolanaWallet, stubSolanaBridgeSuccess, waitForBlockchainRuntime } from '../helpers/blockchain';

import { installProposalEvmBoundary, PROPOSAL_EVM_CONTRACT } from '../helpers/proposal-chain-boundary';

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
  // The register (parcel-ownership/1) names owners only; the owner's wallet comes from the
  // single-owner chain-address hook the parcel panel consults.
  const ownerWallet = (wallet: string) => { (window as any).fetchParcelNftOwnerAddress = async () => wallet; };
  await page.addInitScript(ownerWallet, SOLANA_WALLET);
  await page.evaluate(ownerWallet, SOLANA_WALLET);
  await page.route('**/parcel-ownership/**', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ contract: 'parcel-ownership/1', owners: [{ name: 'Fixture private owner', shareText: '1/1', sharePercent: 100, ownerType: 'private individual' }] }),
  }));
  await openParcel(page, 'info');
  await page.waitForFunction(parcelId => {
    const slots = (window as any).getParcelOwnerSlots?.(parcelId);
    return Array.isArray(slots) && slots.length > 0 && slots.every((slot: any) => !slot.placeholder);
  }, PARCEL_ID);
}

async function chooseLocalProposal(page: import('@playwright/test').Page): Promise<void> {
  const confirm = page.locator('.cb-dialog-overlay--confirm');
  await expect(confirm).toContainText('Proceed to create an in-memory proposal?');
  const inMemoryButton = confirm.getByRole('button', { name: 'Create in memory', exact: true });
  if (await inMemoryButton.count()) await inMemoryButton.click();
  else await confirm.getByRole('button', { name: 'Create', exact: true }).click();
}

async function installMarketRpcFixture(page: import('@playwright/test').Page, resolved: boolean): Promise<void> {
  // The bet dialog first asks the sheet for a city row, then falls back to this chain summary when
  // the proposal is not listed there. Keep that API boundary local so the test reaches the fallback.
  await page.route('**/markets?*', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ contests: [] }),
  }));
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
      simulateTransaction: async (_tx: unknown, config?: unknown) => {
        // Mirrors web3.js 1.x: a legacy Transaction takes signers here, never a config object.
        if (config !== undefined && !Array.isArray(config)) throw new Error('Invalid arguments');
        return { value: { err: null, logs: [] } };
      },
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

async function openProposalSection(page: import('@playwright/test').Page, section: 'land' | 'market'): Promise<void> {
  const details = page.locator(`#proposal-details-panel details[data-proposal-section="${section}"]`);
  await details.locator(':scope > summary').click();
  await expect(details).toHaveJSProperty('open', true);
}

test.describe('Proposal actions @features', () => {
  test('unknown lifecycle stays visible after import and cannot grant owner consent', async ({ mockApi: page }) => {
    await openCity(page);
    await establishLocalProfile(page);
    await loadParcelOwnershipFixture(page);
    const proposalId = await page.evaluate(parcelId => {
      const w = window as any;
      const imported = w.proposalStorage.importProposal({
        proposalId: 'unknown-lifecycle', title: 'Unreported lifecycle', goal: 'parcelBased',
        cadastreParcelIds: [parcelId], expiresAt: '2020-01-01T00:00:00Z',
        acceptedParcelIds: [parcelId], ownerAcceptances: { [parcelId]: { ownerOrder: ['remote-party'], acceptedOwnerKeys: ['remote-party'] } },
      });
      if (imported.acceptedParcelIds.length || Object.keys(imported.ownerAcceptances).length) throw new Error('Imported unsigned consent survived');
      return imported.proposalId;
    }, PARCEL_ID);
    await showProposal(page, proposalId);
    await expandProposalDetails(page);
    await expect(page.locator('#proposal-details-panel .cb-badge').filter({ hasText: 'Status unknown' })).toBeVisible();
    await expect(page.locator('#proposal-details-panel .proposal-expiry-countdown')).toHaveCount(0);
    await openProposalSection(page, 'land');
    const ownerRow = page.locator('#proposal-details-panel .owner-acceptance-row').first();
    await expect(ownerRow).toBeVisible();
    await expect(ownerRow.getByRole('button', { name: 'Accept', exact: true })).toHaveCount(0);
    const proposal = await proposalState(page, proposalId);
    expect(proposal.lifecycleStatus).toBe('Unknown');
    expect(proposal.acceptedParcelIds).toEqual([]);
    expect(proposal.applied).toBe(false);
    await page.evaluate(({ id, parcelId }) => (window as any).handleUserAcceptProposal(id, parcelId), { id: proposalId, parcelId: PARCEL_ID });
    await expect(page.getByText('The proposal status is unknown. Reload it before accepting.', { exact: true })).toBeVisible();
    expect((await proposalState(page, proposalId)).acceptedParcelIds).toEqual([]);
  });

  test('parcel flags and hashless owner records cannot manufacture acceptance', async ({ mockApi: page }) => {
    await openCity(page);
    await establishLocalProfile(page);
    await loadParcelOwnershipFixture(page);
    const proposalId = await page.evaluate((parcelId) => {
      const w = window as any;
      const id = w.proposalStorage.addProposal({
        title: 'Unsubstantiated parcel acceptance', goal: 'parcelBased', lifecycleStatus: 'Active',
        funded: false, cadastreParcelIds: [parcelId],
      });
      const proposal = w.proposalStorage.getProposal(id);
      proposal.acceptedParcelIds = [parcelId];
      proposal.updatedAt = '2026-01-01T00:00:00.000Z';
      w.proposalStorage.save();
      return id;
    }, PARCEL_ID);
    await showProposal(page, proposalId);
    await expandProposalDetails(page);
    await openProposalSection(page, 'land');
    const ownerRow = page.locator('#proposal-details-panel .owner-acceptance-row').first();
    await expect(ownerRow.getByRole('button', { name: 'Accept', exact: true })).toBeVisible();
    expect((await proposalState(page, proposalId)).acceptedParcelIds).toEqual([]);
    expect((await proposalState(page, proposalId)).ownerAcceptances[PARCEL_ID].acceptedBy).toEqual({});

    // Old synthesized records have no commitment; opening the UI must not revive them.
    await page.evaluate(({ id, parcelId }) => {
      const w = window as any;
      const proposal = w.proposalStorage.getProposal(id);
      const entry = proposal.ownerAcceptances[parcelId];
      const key = entry.ownerOrder[0];
      entry.acceptedOwnerKeys = [key];
      entry.acceptedBy[key] = { acceptedAt: '2026-01-01T00:00:00.000Z' };
      proposal.acceptedParcelIds = [parcelId];
      w.proposalStorage.save();
    }, { id: proposalId, parcelId: PARCEL_ID });
    await showProposal(page, proposalId);
    await expandProposalDetails(page);
    const land = page.locator('#proposal-details-panel details[data-proposal-section="land"]');
    if (!(await land.evaluate(node => (node as HTMLDetailsElement).open))) await openProposalSection(page, 'land');
    await expect(ownerRow.getByRole('button', { name: 'Accept', exact: true })).toBeVisible();
    await expect(ownerRow.locator('.owner-acceptance-changed')).toHaveCount(0);
    expect((await proposalState(page, proposalId)).acceptedParcelIds).toEqual([]);
    await ownerRow.getByRole('button', { name: 'Accept', exact: true }).click();
    await expect(ownerRow.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
    const accepted = await proposalState(page, proposalId);
    const entry = accepted.ownerAcceptances[PARCEL_ID];
    expect(entry.acceptedBy[entry.ownerOrder[0]].effectHash).toBeTruthy();
    expect(entry.acceptanceHistory[0].acceptedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(accepted.acceptedParcelIds).toEqual([PARCEL_ID]);
  });

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
        funded: false,
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
    await openProposalSection(page, 'land');

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

  test('final local acceptance records consent without execution or ownership changes', async ({ mockApi: page }) => {
    await openCity(page);
    await establishLocalProfile(page);
    await loadParcelOwnershipFixture(page);
    const proposalId = await page.evaluate((parcelId) => (window as any).proposalStorage.addProposal({
      title: 'Single owner consent',
      goal: 'parcelBased',
      lifecycleStatus: 'Active',
      funded: true,
      offer: 0,
      cadastreParcelIds: [parcelId],
    }), PARCEL_ID);
    const ownerBefore = await page.evaluate(parcelId => (window as any).PersistentStorage.getItem(`parcel_${parcelId}_owner`), PARCEL_ID);
    await showProposal(page, proposalId);
    await expandProposalDetails(page);
    await openProposalSection(page, 'land');

    const ownerRow = page.locator('.owner-acceptance-row').first();
    await expect(ownerRow.getByRole('button', { name: 'Accept' })).toBeVisible();
    await ownerRow.getByRole('button', { name: 'Accept' }).click();

    await expect.poll(async () => (await proposalState(page, proposalId)).acceptedParcelIds).toEqual([PARCEL_ID]);
    const accepted = await proposalState(page, proposalId);
    expect(accepted.lifecycleStatus).toBe('Active');
    expect(accepted.executedAt).toBeFalsy();
    expect(accepted.applied).toBe(false);
    expect(await page.evaluate(parcelId => (window as any).PersistentStorage.getItem(`parcel_${parcelId}_owner`), PARCEL_ID)).toBe(ownerBefore);
    const profile = await page.evaluate(() => (window as any).getCurrentUserAgent());
    expect(profile.proposalsAccepted).toContain(proposalId);
    expect(profile.proposalsExecuted).not.toContain(proposalId);
    await expect(ownerRow.getByRole('button', { name: 'Undo' })).toBeVisible();
    await expect(page.locator('#proposal-details-panel').getByRole('button', { name: /Apply to map/ })).toBeVisible();
  });

  test('withdrawing local consent preserves the recorded execution lifecycle', async ({ mockApi: page }) => {
    await openCity(page);
    await establishLocalProfile(page);
    await loadParcelOwnershipFixture(page);
    const proposalId = await page.evaluate(parcelId => {
      const w = window as any;
      const id = w.proposalStorage.addProposal({ title: 'Previously executed record', goal: 'parcelBased',
        lifecycleStatus: 'Executed', executedAt: '2026-10-01T10:00:00.000Z', cadastreParcelIds: [parcelId] });
      const p = w.proposalStorage.getProposal(id);
      const owners = w.getOwnerSlotsForParcel(parcelId);
      const key = owners[0].key;
      const entry = w.ensureOwnerAcceptanceEntry(p, parcelId, owners);
      entry.acceptedOwnerKeys = [key];
      entry.acceptedBy[key] = { agentId: w.getCurrentUserAgent().id,
        acceptedAt: '2026-10-01T10:00:00.000Z', effectHash: w.currentConsentBindingHash(p) };
      w.refreshProposalAcceptanceValidity(p);
      w.setProposalApplied(p, true);
      w.proposalStorage.save();
      return id;
    }, PARCEL_ID);
    await showProposal(page, proposalId);
    await expandProposalDetails(page);
    await openProposalSection(page, 'land');
    const ownerRow = page.locator('.owner-acceptance-row').first();
    const executed = await proposalState(page, proposalId);
    expect(executed.acceptedParcelIds).toContain(PARCEL_ID);
    expect(executed.executedAt).toBeTruthy();
    await ownerRow.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => (await proposalState(page, proposalId)).acceptedParcelIds).toEqual([]);
    const withdrawn = await proposalState(page, proposalId);
    expect(withdrawn.lifecycleStatus).toBe('Executed');
    expect(withdrawn.executedAt).toBe(executed.executedAt);
    expect(withdrawn.applied).toBe(executed.applied);
  });

  test('EVM acceptance records consent and an applied Active conditional offer can withdraw it', async ({ mockApi: page }) => {
    await injectMockEvmWallet(page, { chainIdHex: '0x14a34', walletKind: 'metamask' });
    await openCity(page);
    await establishLocalProfile(page);
    await loadParcelOwnershipFixture(page);
    await connectWalletByConnectorId(page, 'metamask');
    await installProposalEvmBoundary(page);
    const proposalId = await page.evaluate(({ parcelId, contract }) => {
      const w = window as any;
      const id = w.proposalStorage.addProposal({
        title: 'Applied conditional consent', goal: 'parcelBased', lifecycleStatus: 'Active',
        funded: true, isConditional: true, cadastreParcelIds: [parcelId],
        nft: { chain: '84532', contract, tokenId: '5' },
      });
      const p = w.proposalStorage.getProposal(id);
      w.setProposalApplied(p, true);
      w.proposalStorage.save();
      return id;
    }, { parcelId: PARCEL_ID, contract: PROPOSAL_EVM_CONTRACT });
    await showProposal(page, proposalId);
    await expandProposalDetails(page);
    await openProposalSection(page, 'land');
    await page.locator('.owner-acceptance-row').first().getByRole('button', { name: 'Accept', exact: true }).click();
    await expect.poll(async () => (await proposalState(page, proposalId)).acceptedParcelIds).toEqual([PARCEL_ID]);
    const accepted = await proposalState(page, proposalId);
    expect(accepted.lifecycleStatus).toBe('Active');
    expect(accepted.executedAt).toBeFalsy();
    expect(accepted.applied).toBe(true);
    expect(await page.evaluate(() => (window as any).__proposalEvmStatusRead)).toEqual({ proposalId: '5', blockTag: '0x1' });
    expect(await page.evaluate(() => {
      const w = window as any;
      return w.__proposalEvmSubmitted?.data?.slice(0, 10)
        === w.ethers.id('acceptProposal(uint256,string,bytes32,bytes32,bytes32)').slice(0, 10);
    })).toBe(true);
    await page.locator('.owner-acceptance-row').first().getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => (await proposalState(page, proposalId)).acceptedParcelIds).toEqual([]);
    const after = await proposalState(page, proposalId);
    expect(after.lifecycleStatus).toBe('Active');
    expect(after.applied).toBe(true);
    expect(await page.evaluate(() => {
      const w = window as any;
      return w.__proposalEvmSubmitted?.data?.slice(0, 10)
        === w.ethers.id('withdrawAcceptance(uint256,string,bytes32,bytes32,bytes32)').slice(0, 10);
    })).toBe(true);
  });

  for (const statusRead of ['Executed', 'unavailable'] as const) {
    test(`EVM acceptance refreshes lifecycle from its receipt block: ${statusRead}`, async ({ mockApi: page }) => {
      await injectMockEvmWallet(page, { chainIdHex: '0x14a34', walletKind: 'metamask' });
      await openCity(page);
      await establishLocalProfile(page);
      await loadParcelOwnershipFixture(page);
      await connectWalletByConnectorId(page, 'metamask');
      await installProposalEvmBoundary(page, { acceptanceStatusCode: 1, failAcceptanceStatusRead: statusRead === 'unavailable' });
      const proposalId = await page.evaluate(({ parcelId, contract }) => (window as any).proposalStorage.addProposal({
        title: 'Receipt-block lifecycle', goal: 'parcelBased', kind: 'owner-deal', lifecycleStatus: 'Active',
        funded: true, isConditional: true, cadastreParcelIds: [parcelId],
        nft: { chain: '84532', contract, tokenId: '5' },
      }), { parcelId: PARCEL_ID, contract: PROPOSAL_EVM_CONTRACT });
      await showProposal(page, proposalId);
      await expandProposalDetails(page);
      await openProposalSection(page, 'land');
      const ownerBefore = await page.evaluate(parcelId => (window as any).PersistentStorage.getItem(`parcel_${parcelId}_owner`), PARCEL_ID);
      await page.locator('.owner-acceptance-row').first().getByRole('button', { name: 'Accept', exact: true }).click();
      await expect.poll(async () => (await proposalState(page, proposalId)).acceptedParcelIds).toEqual([PARCEL_ID]);
      await expect.poll(async () => (await proposalState(page, proposalId)).lifecycleStatus)
        .toBe(statusRead === 'Executed' ? 'Executed' : 'Active');
      const accepted = await proposalState(page, proposalId);
      expect(accepted.executedAt).toBeFalsy();
      expect(accepted.applied).toBe(false);
      expect(await page.evaluate(parcelId => (window as any).PersistentStorage.getItem(`parcel_${parcelId}_owner`), PARCEL_ID)).toBe(ownerBefore);
      expect(await page.evaluate(() => (window as any).__proposalEvmStatusRead)).toEqual({ proposalId: '5', blockTag: '0x1' });
      const profile = await page.evaluate(() => (window as any).getCurrentUserAgent());
      expect(profile.proposalsAccepted).toContain(proposalId);
      expect(profile.proposalsExecuted).not.toContain(proposalId);
      if (statusRead === 'unavailable') {
        await expect(page.getByText('Acceptance was confirmed on-chain, but the proposal status could not be refreshed.', { exact: false })).toBeVisible();
      } else {
        await expect(page.locator('#proposal-details-panel').getByRole('link', { name: /^Executed/ })).toBeVisible();
        await expect(page.locator('#proposal-details-panel details[data-proposal-section="land"]')).toHaveAttribute('open', '');
      }
    });
  }

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
        simulateTransaction: async (_tx: unknown, config?: unknown) => {
        // Mirrors web3.js 1.x: a legacy Transaction takes signers here, never a config object.
        if (config !== undefined && !Array.isArray(config)) throw new Error('Invalid arguments');
        return { value: { err: null, logs: [] } };
      },
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
    await expect(dialog).toHaveAttribute('data-support-kind', 'donate');
    await dialog.locator('#proposalBoostAmount').fill('1.25');
    await dialog.locator('[data-support-submit]').click();

    await expect(dialog).toBeHidden();
    const confirmation = page.locator('.cb-dialog-overlay--confirm');
    await expect(confirmation).toContainText('Success! Thank you for supporting this proposal with 1.25 USDC.');
    await expect(confirmation.getByRole('link', { name: 'See transaction on Solana Explorer' }))
      .toHaveAttribute('href', 'https://explorer.solana.com/tx/5N2o4X1mockSignature?cluster=devnet');
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
    await dialog.locator('#proposalOwnerOfferCheckbox').uncheck();
    await expect.poll(() => page.evaluate(() => (window as any).proposalOwnerOfferMode)).toBe(false);
    await dialog.locator('#proposalOwnerOfferCheckbox').check();
    await expect.poll(() => page.evaluate(() => (window as any).proposalOwnerOfferMode)).toBe(true);
    await dialog.locator('#proposalName').fill('Verified parcel owner offer');
    await dialog.locator('#proposalDescription').fill('The attested owner offers this parcel for a new community park.');
    await dialog.locator('#proposalOptionsSection > .collapsible-header').click();
    await expect(dialog.locator('#proposalOffer')).toBeVisible();
    await dialog.locator('#proposalOffer').fill('1000');
    await page.evaluate(() => {
      const w = window as any;
      const addProposal = w.proposalStorage.addProposal;
      w.proposalStorage.addProposal = function (proposal: any) {
        if (proposal.goal === 'ownership-transfer-from-me') {
          w.__createdSellerOffer = JSON.parse(JSON.stringify(proposal));
        }
        return addProposal.call(this, proposal);
      };
    });
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
    const authored = await page.evaluate(() => (window as any).__createdSellerOffer);
    expect(authored.lifecycleStatus).toBe('Active');
    expect(offer.lifecycleStatus).toBe('Active');
    expect(authored.acceptedParcelIds).toEqual([]);
    expect(authored.ownerAcceptances).toEqual({});
    expect(authored.ownershipTransferProposal).not.toHaveProperty('status');
    expect(offer.funded).toBe(false);
    await showProposal(page, offer.proposalId);
    await expandProposalDetails(page);
    await expect(page.locator('#proposal-details-panel .cb-badge').filter({ hasText: 'Awaiting funding' })).toBeVisible();
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
    await mintDialog.locator('.parcel-mint-close').click();
    await expect(mintDialog).toBeHidden();
    await expect(mint).toBeEnabled();
    await mint.click();
    await expect(mintDialog).toBeVisible();
    await mintDialog.getByRole('button', { name: 'Mint', exact: true }).click();

    const success = page.locator('#parcel-mint-success-modal');
    await expect(success).toBeVisible({ timeout: 15000 });
    await expect(success).toContainText('Parcel has been minted');
    await expect(success.locator('a[href*="explorer.solana.com/tx/"]')).toBeVisible();
    await success.getByRole('button', { name: 'OK', exact: true }).click();
    await expect(success).toBeHidden();
  });

  for (const [side, label, sideValue] of [[1, 'yes', 1], [0, 'no', 0]] as const) {
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
    await openProposalSection(page, 'market');

    const market = page.locator('.proposal-market-summary');
    const stakeButton = market.getByRole('button', { name: `Bet ${label}`, exact: true });
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
    await openProposalSection(page, 'market');

    const market = page.locator('.proposal-market-summary');
    await market.getByRole('button', { name: 'Collect yes winnings' }).click({ timeout: 10000 });
    await expect(market.locator('[data-market="status"]')).toContainText('Confirmed on Solana.', { timeout: 10000 });
    expect(await page.evaluate(() => (window as any).__proposalMarketRpcEvents)).toEqual(['send', 'confirm']);
  });
});
