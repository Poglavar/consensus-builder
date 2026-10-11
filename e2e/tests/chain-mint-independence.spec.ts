// Minting commits the complete proposal record to chain metadata first. The optional server row
// mirrors that immutable chain location; no signed /proposals/prepare step gates the mint.
import { test, expect } from '../helpers/fixtures';
import { openCity, createSpace, showProposal } from '../helpers/runtime';
import { connectWalletByConnectorId, injectMockEvmWallet } from '../helpers/blockchain';

const WALLET = '0x1234567890abcdef1234567890abcdef12345678';
const CONTRACT = '0x9699AcBc70a32E5a7Ff30566dD496e080a4FAE2F';
const METADATA_URI = 'ipfs://QmMintedProposalMetadata000000000000000000000000000000000000';

async function prepareShareMint(page: import('@playwright/test').Page, uploadFails = false): Promise<void> {
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
  const proposalId = await createSpace(page, 'park');
  await page.evaluate(({ id, wallet, fails, metadataUri, contract }) => {
    const w = window as any;
    const proposal = w.proposalStorage.getProposal(id);
    if (!proposal) throw new Error(`Missing test proposal ${id}`);
    proposal.lens = [{ address: wallet }];
    proposal.screenshotDataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    w.proposalStorage.save();
    w.__chainMintE2e = { uploadCalls: [], mintCalls: [] };
    w.AssetService = {
      uploadProposalAssets: async (args: any) => {
        w.__chainMintE2e.uploadCalls.push(args);
        if (fails) throw new Error('mock metadata upload failed');
        return { metadataUri, metadataGatewayUrl: 'https://gateway.example/metadata.json' };
      }
    };
    // Keep the mint dialog path real while replacing the final wallet transaction and its RPC
    // prerequisite lookup, so this spec never submits or simulates a paid transaction.
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
  }, { id: proposalId, wallet: WALLET, fails: uploadFails, metadataUri: METADATA_URI, contract: CONTRACT });
  await showProposal(page, proposalId);
  await page.locator('.btn-share-proposal').click();
  await expect(page.locator('.share-modal-overlay')).toBeVisible();
}

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

    expect(evidence.mintCalls).toHaveLength(1);
    expect(evidence.mintCalls[0]).toMatchObject({ parcelIds: proposalRecord.cadastreParcelIds, imageURI: METADATA_URI });
    expect(requests.filter(call => call.path.endsWith('/proposals/prepare'))).toHaveLength(0);
    const mirror = requests.find(call => call.path.endsWith('/proposals/mirror'));
    expect(mirror).toMatchObject({ method: 'POST', body: { chainRef: { chainType: 'evm', chainId: '84532', contract: CONTRACT, tokenId: '77' } } });
    expect(Object.keys(mirror!.body)).toEqual(['chainRef']);
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
