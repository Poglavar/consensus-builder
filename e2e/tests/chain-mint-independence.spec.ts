// Minting commits the complete proposal record to chain metadata first. The optional server row
// mirrors that immutable chain location; no signed /proposals/prepare step gates the mint.
import { test, expect } from '../helpers/fixtures';
import { openCity, showProposal, createSpace, chooseProposalKind, PARCEL_GEOMETRY, PARCEL_ID } from '../helpers/runtime';
import { selectNativeOption } from '../helpers/controls';
import { connectWalletByConnectorId, injectMockEvmWallet } from '../helpers/blockchain';

const WALLET = '0x1234567890abcdef1234567890abcdef12345678';
const CONTRACT = '0xFf162bC8De48AA39582c9389D60a7487b6330342';
const SOLANA_AUTHOR = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const SOLANA_LENS = 'GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSMQRdW';
const METADATA_URI = 'ipfs://QmMintedProposalMetadata000000000000000000000000000000000000';

async function connectAuthorWallet(page: import('@playwright/test').Page): Promise<void> {
  await injectMockEvmWallet(page, { account: WALLET, chainIdHex: '0x14a34', walletKind: 'metamask' });
  await page.addInitScript(() => {
    const wallet = (window as any).ethereum;
    const request = wallet.request.bind(wallet);
    wallet.request = (args: any) => {
      if (args.method === 'eth_blockNumber') return Promise.resolve('0x1');
      if (args.method === 'eth_getBalance') return Promise.resolve('0x0');
      if (args.method === 'eth_getLogs') return Promise.resolve([]);
      return request(args);
    };
  });
  await openCity(page);
  await page.locator('#username-display').click();
  await page.locator('#username-input').fill('Chain proposal author');
  await page.locator('#welcome-submit-btn').click();
  await expect(page.locator('#welcome-modal')).toBeHidden();
  await connectWalletByConnectorId(page, 'metamask');
}

// Keep the mint path real while replacing the asset upload, the final wallet transaction and its
// RPC prerequisite lookup, so these specs never submit or simulate a paid transaction.
async function stubChain(page: import('@playwright/test').Page, uploadFails = false): Promise<void> {
  await page.evaluate(({ fails, metadataUri, contract }) => {
    const w = window as any;
    w.__chainMintE2e = { uploadCalls: [], mintCalls: [] };
    w.AssetService = {
      uploadProposalAssets: async (args: any) => {
        w.__chainMintE2e.uploadCalls.push(args);
        if (fails) throw new Error('mock metadata upload failed');
        return { metadataUri, metadataGatewayUrl: 'https://gateway.example/metadata.json' };
      }
    };
    w.checkParcelsHaveNFTs = async (parcelIds: string[], chainId: string) => ({
      allHaveNFTs: true, missingParcels: [], chainId, chainName: 'Base Sepolia'
    });
    w.ProposalChainBridge = {
      isSupported: () => true,
      mintProposal: async (args: any) => {
        w.__chainMintE2e.mintCalls.push(args);
        return { transactionHash: '0xfake-mint', proposalId: '77', chainId: '84532', contractAddress: contract };
      }
    };
  }, { fails: uploadFails, metadataUri: METADATA_URI, contract: CONTRACT });
}

// A legacy parcel proposal whose terms were chosen (kind and money below), so Share opens the
// share dialog straight away.
const OWNER_DEAL_TERMS = { kind: 'owner-deal', offer: 0.25, offerCurrency: 'ETH', budget: 0.25, budgetCurrency: 'ETH', isConditional: true, termsConfirmed: true };

async function prepareShareMint(page: import('@playwright/test').Page, uploadFails = false, terms: Record<string, unknown> = OWNER_DEAL_TERMS): Promise<void> {
  await connectAuthorWallet(page);
  const proposalId = await page.evaluate(({ parcelId, geometry, wallet, terms }) => (window as any).proposalStorage.addProposal({
    proposalId: 'chain-mint-independence-legacy-source', title: 'Chain mint independence proposal',
    description: 'A legacy parcel proposal used to exercise the chain mint path.', goal: 'park', lifecycleStatus: 'Active',
    city: 'zagreb', cadastreParcelIds: [parcelId], geometry,
    structureProposal: { kind: 'park', geometry, applied: true },
    lens: [{ address: wallet }], screenshotDataUrl: 'data:image/png;base64,iVBORw0KGgo=', ...terms,
  }), { parcelId: PARCEL_ID, geometry: PARCEL_GEOMETRY, wallet: WALLET, terms });
  await page.evaluate(id => {
    const w = window as any;
    const proposal = w.proposalStorage.getProposal(id);
    if (!proposal) throw new Error(`Missing test proposal ${id}`);
    if (proposal.approvalConfig != null || w.ProposalApprovalRuntime?.uses(proposal)) {
      throw new Error('Mint fixture must remain a legacy proposal without abstract approval configuration.');
    }
  }, proposalId);
  await stubChain(page, uploadFails);
  await showProposal(page, proposalId);
  await page.locator('.btn-share-proposal').click();
  await expect(page.locator('.share-modal-overlay')).toBeVisible();
}

const traits = (metadata: any) => Object.fromEntries(metadata.attributes.map((a: any) => [a.trait_type, a.value]));

async function interceptMirrorRequests(page: import('@playwright/test').Page) {
  const calls: Array<{ method: string; path: string; body: any }> = [];
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith('/proposals/prepare')) {
      calls.push({ method: request.method(), path: url.pathname, body: request.postDataJSON() });
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'prepare must not be called' }) });
      return;
    }
    if (url.pathname.endsWith('/proposals/mirror')) {
      calls.push({ method: request.method(), path: url.pathname, body: request.postDataJSON() });
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 9101, proposalId: 'chain_test' }) });
      return;
    }
    await route.fallback();
  });
  return calls;
}

test.describe('chain mint independence @features', () => {
  test('the Share dialog mints full metadata, then mirrors only the chain location', async ({ mockApi: page }) => {
    const requests = await interceptMirrorRequests(page);
    await prepareShareMint(page);

    await page.locator('.share-modal-overlay').getByRole('button', { name: 'Mint', exact: true }).click();
    await expect(page.locator('.share-modal-overlay')).toContainText(/Success!|Minted/i, { timeout: 30_000 });

    const evidence = await page.evaluate(() => (window as any).__chainMintE2e);
    expect(evidence.uploadCalls).toHaveLength(1);
    const metadata = evidence.uploadCalls[0].metadata;
    const proposalRecord = metadata.properties.proposal;
    expect(metadata.properties.proposalProtocol).toBe('proposal-chain/1');
    expect(proposalRecord.site).toBeTruthy();
    expect(proposalRecord.cadastreSnapshot).toMatchObject({ protocol: 'cadastre-snapshot/1', regionHasCadastre: true });
    expect(proposalRecord.cadastreSnapshot.parcels.length).toBeGreaterThan(0);
    expect(proposalRecord.cadastreParcelIds).toEqual(expect.arrayContaining(proposalRecord.binding.parcels.map((p: any) => p.parcelId)));
    expect(proposalRecord.cadastreSnapshot.parcels[0]).toMatchObject({ id: proposalRecord.cadastreParcelIds[0], geometry: expect.any(Object), geometryHash: expect.any(String) });

    expect(proposalRecord).toMatchObject({ kind: 'owner-deal', offer: 0.25, offerCurrency: 'ETH' });
    expect(traits(metadata)).toMatchObject({ Kind: 'owner-deal', Offer: '0.25 ETH' });

    expect(evidence.mintCalls).toHaveLength(1);
    // An owner deal escrows its offer in the chain's own currency.
    expect(evidence.mintCalls[0]).toMatchObject({ parcelIds: proposalRecord.cadastreParcelIds, imageURI: METADATA_URI, ethAmount: 0.25, isVote: false, isConditional: true });
    expect(requests.filter(call => call.path.endsWith('/proposals/prepare'))).toHaveLength(0);
    const mirror = requests.find(call => call.path.endsWith('/proposals/mirror'));
    expect(mirror).toMatchObject({ method: 'POST', body: { chainRef: { chainType: 'evm', chainId: '84532', contract: CONTRACT, tokenId: '77' } } });
    expect(Object.keys(mirror!.body)).toEqual(['chainRef']);
  });

  test('the Share dialog mints a community vote fund-less, with its voting deadline and no offer', async ({ mockApi: page }) => {
    await interceptMirrorRequests(page);
    await prepareShareMint(page, false, { kind: 'community-vote', offer: null, budget: null, voteExpiryDays: 30, isConditional: false, termsConfirmed: true });
    await page.locator('.share-modal-overlay').getByRole('button', { name: 'Mint', exact: true }).click();
    await expect(page.locator('.share-modal-overlay')).toContainText(/Success!|Minted/i, { timeout: 30_000 });

    const evidence = await page.evaluate(() => (window as any).__chainMintE2e);
    const metadata = evidence.uploadCalls[0].metadata;
    expect(metadata.properties.proposal).toMatchObject({ kind: 'community-vote', offer: null, voteExpiryDays: 30 });
    expect(traits(metadata)).toMatchObject({ Kind: 'community-vote' });
    expect(traits(metadata)).not.toHaveProperty('Offer');
    expect(evidence.mintCalls).toHaveLength(1);
    expect(evidence.mintCalls[0]).toMatchObject({ isVote: true, expiryDays: 30, ethAmount: 0 });
  });

  test('Share on a quick drawing appends its terms in place and the share dialog mints it on Solana', async ({ mockApi: page }) => {
    test.setTimeout(90_000);
    const requests = await interceptMirrorRequests(page);
    await openCity(page);
    await page.locator('#username-display').click();
    await page.locator('#username-input').fill('Chain proposal author');
    await page.locator('#welcome-submit-btn').click();
    await expect(page.locator('#welcome-modal')).toBeHidden();
    const drawingId = await createSpace(page, 'park');
    await stubChain(page);
    await page.evaluate(({ author, lens }) => {
      const w = window as any;
      w.solanaWalletManager.getState = () => ({ status: 'connected', accounts: [author], walletId: 'solana-phantom' });
      w.solanaWalletManager.getCluster = () => 'devnet';
      w.LensPicker.isActive = () => true;
      w.LensPicker.getEntries = () => [{ address: lens }];
      w.checkParcelsHaveNFTsSolana = async (parcelIds: string[], chainId: string) => ({ allHaveNFTs: true, missingParcels: [], chainId });
      w.SolanaProposalChainBridge = {
        isSupported: () => true,
        supportsProposalApproval: (schema: string) => schema === 'proposal-approval/v1',
        mintProposal: async (args: any) => {
          w.__chainMintE2e.mintCalls.push(args);
          return { transactionHash: 'solanaMintSignature', proposalId: 'ProposalPda111', chainId: 'solana-devnet', contractAddress: 'ProposalProgram111' };
        }
      };
    }, { author: SOLANA_AUTHOR, lens: SOLANA_LENS });
    await showProposal(page, drawingId);
    await page.locator('.btn-share-proposal').click();

    const form = page.locator('.create-proposal-modal:visible');
    await expect(form).toBeVisible();
    await expect(form.locator('input[name="proposalKind"][value="community-vote"]')).toBeChecked();
    await form.locator('#createProposalSubmitButton').click();
    // The terms are appended to the drawing itself; the share dialog then mints that record.
    const shareDialog = page.locator('.share-modal-overlay');
    await expect(shareDialog).toBeVisible({ timeout: 30_000 });
    await shareDialog.getByRole('button', { name: 'Mint', exact: true }).click();
    await expect(shareDialog).toContainText(/Success!|Minted/i, { timeout: 45_000 });

    const evidence = await page.evaluate(() => (window as any).__chainMintE2e);
    expect(evidence.mintCalls).toHaveLength(1);
    // A community vote escrows nothing and its verdict never executes.
    expect(evidence.mintCalls[0]).toMatchObject({ solAmount: 0, verdictMayExecute: false, approvalSetup: false, lens: [SOLANA_LENS], imageURI: METADATA_URI });
    expect(evidence.mintCalls[0].siteHash).toHaveLength(32);
    const metadata = evidence.uploadCalls[0].metadata;
    expect(metadata.properties.proposal).toMatchObject({ kind: 'community-vote', offer: null, voteExpiryDays: 365 });
    const saved = await page.evaluate(() => (window as any).proposalStorage.getAllProposals()
      .find((p: any) => p.kind === 'community-vote' && p.termsConfirmed));
    expect(saved.proposalId).toBe(drawingId);
    expect(saved.onchain).toMatchObject({ proposalId: 'ProposalPda111', chainId: 'solana-devnet', metadataUri: METADATA_URI });
    expect(requests.filter(call => call.path.endsWith('/proposals/mirror'))).toHaveLength(1);
  });

  test('Share on a quick drawing with Phantom and no lens chosen asks for the lens before saving its terms', async ({ mockApi: page }) => {
    await openCity(page);
    await page.locator('#username-display').click();
    await page.locator('#username-input').fill('Chain proposal author');
    await page.locator('#welcome-submit-btn').click();
    await expect(page.locator('#welcome-modal')).toBeHidden();
    const drawingId = await createSpace(page, 'park');
    await page.evaluate(author => {
      const w = window as any;
      w.solanaWalletManager.getState = () => ({ status: 'connected', accounts: [author], walletId: 'solana-phantom' });
      w.solanaWalletManager.getCluster = () => 'devnet';
      w.LensPicker.isActive = () => true;
      w.LensPicker.getEntries = () => [];
      w.__lensPickerShown = 0;
      w.LensPicker.show = () => { w.__lensPickerShown += 1; };
    }, SOLANA_AUTHOR);
    await showProposal(page, drawingId);
    await page.locator('.btn-share-proposal').click();
    const form = page.locator('.create-proposal-modal:visible');
    await expect(form).toBeVisible();
    await form.locator('#createProposalSubmitButton').click();
    // Stopped at the terms, with the lens picker opened, instead of failing later in the share dialog.
    await expect.poll(() => page.evaluate(() => (window as any).__lensPickerShown)).toBe(1);
    await expect(page.getByText('Choose at least one lens member', { exact: false })).toBeVisible();
    await expect(page.locator('.share-modal-overlay')).toHaveCount(0);
    expect(await page.evaluate(id => (window as any).proposalStorage.getProposal(id).termsConfirmed ?? null, drawingId)).toBe(null);
  });

  test('Share on a quick drawing mints an owner deal of half an ETH on EVM, with its offer escrowed', async ({ mockApi: page }) => {
    // A drawing whose author set no approval carries no approval setup, so EVM mints it.
    test.setTimeout(90_000);
    const requests = await interceptMirrorRequests(page);
    await connectAuthorWallet(page);
    const drawingId = await createSpace(page, 'park');
    await stubChain(page);
    await showProposal(page, drawingId);
    await page.locator('.btn-share-proposal').click();

    const form = page.locator('.create-proposal-modal:visible');
    await expect(form).toBeVisible();
    await chooseProposalKind(form, 'owner-deal');
    if (!(await form.locator('#proposalOffer').isVisible())) {
      await form.locator('#proposalOptionsSection > .collapsible-header').click();
    }
    // A fraction of a coin is a valid offer.
    await form.locator('#proposalOffer').fill('0.5');
    await selectNativeOption(form.locator('#proposalCurrency'), 'ETH');
    await form.locator('#createProposalSubmitButton').click();
    const shareDialog = page.locator('.share-modal-overlay');
    await expect(shareDialog).toBeVisible({ timeout: 30_000 });
    await shareDialog.getByRole('button', { name: 'Mint', exact: true }).click();
    await expect(shareDialog).toContainText(/Success!|Minted/i, { timeout: 45_000 });

    const evidence = await page.evaluate(() => (window as any).__chainMintE2e);
    expect(evidence.mintCalls).toHaveLength(1);
    expect(evidence.mintCalls[0]).toMatchObject({ ethAmount: 0.5, isVote: false, approvalSetup: false, imageURI: METADATA_URI });
    const saved = await page.evaluate(() => (window as any).proposalStorage.getAllProposals()
      .find((p: any) => p.kind === 'owner-deal' && p.termsConfirmed));
    expect(saved).toMatchObject({ proposalId: drawingId, offer: 0.5, offerCurrency: 'ETH', onchain: { proposalId: '77', contractAddress: CONTRACT } });
    expect(saved).not.toHaveProperty('approvalConfig');
    expect(requests.filter(call => call.path.endsWith('/proposals/mirror'))).toHaveLength(1);
  });

  test('metadata upload failure stops before the wallet mint bridge', async ({ mockApi: page }) => {
    const requests = await interceptMirrorRequests(page);
    await prepareShareMint(page, true);
    await page.locator('.share-modal-overlay').getByRole('button', { name: 'Mint', exact: true }).click();
    await expect(page.locator('.share-modal-overlay')).toContainText('mock metadata upload failed', { timeout: 30_000 });

    const evidence = await page.evaluate(() => (window as any).__chainMintE2e);
    expect(evidence.uploadCalls).toHaveLength(1);
    expect(evidence.mintCalls).toHaveLength(0);
    expect(requests.filter(call => call.path.endsWith('/proposals/prepare') || call.path.endsWith('/proposals/mirror'))).toHaveLength(0);
  });
});
