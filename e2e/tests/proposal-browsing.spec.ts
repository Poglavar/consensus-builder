import { test, expect } from '../helpers/fixtures';
import { clickMapPoint, openCity, PARCEL_GEOMETRY, PARCEL_ID, proposalState, showProposal } from '../helpers/runtime';
import { connectWalletByConnectorId, injectMockSolanaWallet, waitForBlockchainRuntime } from '../helpers/blockchain';

const SOLANA_WALLET = '7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT';
const PROPOSAL_ACCOUNT = '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg';
const PARCEL_PROGRAM = '4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1';

async function chooseInMemoryProposal(page: import('@playwright/test').Page): Promise<void> {
  const confirm = page.locator('.cb-confirm-overlay');
  await expect(confirm).toContainText('Proceed to create an in-memory proposal?');
  const inMemoryButton = confirm.getByRole('button', { name: 'Create in memory', exact: true });
  if (await inMemoryButton.count()) await inMemoryButton.click();
  else await confirm.getByRole('button', { name: 'Create', exact: true }).click();
}

async function installMarketRpcFixture(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(({ proposal, wallet }) => {
    const w = window as any;
    const client = w.SolanaMarketClient;
    const web3 = w.solanaWeb3;
    const proposalKey = new web3.PublicKey(proposal);
    const [marketPda] = client.getMarketPda(proposalKey);
    const marketBytes = new Uint8Array(client.MARKET_SIZE);
    let offset = 0;
    const put = (bytes: Uint8Array) => { marketBytes.set(bytes, offset); offset += bytes.length; };
    // Anchor discriminator for the real proposal_market::Market account layout.
    put(Uint8Array.from([219, 190, 213, 55, 0, 227, 198, 154]));
    put(proposalKey.toBytes()); put(new web3.PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU').toBytes()); put(new Uint8Array(32));
    put(new Uint8Array(18));
    const marketAddress = marketPda.toBase58();
    const connection = {
      getAccountInfo: async (key: any) => key.toBase58() === marketAddress ? { data: marketBytes, owner: new web3.PublicKey(client.constants.PROGRAM_ID) } : null,
      getBalance: async () => 2_000_000_000,
      getTokenAccountBalance: async () => ({ value: { amount: '50000000', decimals: 6 } }),
      getLatestBlockhash: async () => ({ blockhash: 'EkSnNWid2cvwEVnVx9aBqpiCpY1QoUW63D2Hp31e4gwJ', lastValidBlockHeight: 99 }),
      simulateTransaction: async () => ({ value: { err: null, logs: [] } }),
      sendRawTransaction: async () => '5N2o4X1mockSignature',
      confirmTransaction: async () => ({ value: { err: null } }),
    };
    const provider = w.solanaWalletManager?.getProvider?.();
    if (!provider) throw new Error('Connected Solana provider is unavailable');
    provider.signTransaction = async (transaction: any) => { transaction.serialize = () => new Uint8Array([1, 2, 3]); return transaction; };
    w.SolanaChainDataLoader.getConnection = () => connection;
  }, { proposal: PROPOSAL_ACCOUNT, wallet: SOLANA_WALLET });
}

async function expandProposalDetails(page: import('@playwright/test').Page): Promise<void> {
  const expand = page.locator('#proposal-details-panel').getByRole('button', { name: 'Expand', exact: true });
  if (await expand.isVisible()) await expand.click();
}

test.describe('Proposal browsing @features', () => {
  test('local list filters, sorts and switches proposal sources through visible controls', async ({ mockApi: page }) => {
    await openCity(page);
    const ids = await page.evaluate((parcelId) => {
      const w = window as any;
      return [
        w.proposalStorage.addProposal({ title: 'North park plan', goal: 'park', author: 'Ada', createdAt: '2024-01-01T00:00:00Z', lifecycleStatus: 'Active', cadastreParcelIds: [parcelId] }),
        w.proposalStorage.addProposal({ title: 'South park plan', goal: 'park', author: 'Bea', createdAt: '2025-01-01T00:00:00Z', lifecycleStatus: 'Active', cadastreParcelIds: [parcelId] }),
        w.proposalStorage.addProposal({ title: 'Road safety plan', goal: 'road-track', author: 'Ada', createdAt: '2023-01-01T00:00:00Z', lifecycleStatus: 'Active', cadastreParcelIds: [parcelId] }),
      ];
    }, PARCEL_ID);

    await page.locator('#proposals-button').click();
    await page.locator('#showProposalsButton').click();
    const list = page.locator('.proposal-list-modal');
    await expect(list.locator('.proposal-list-item')).toHaveCount(3);
    // Desktop shows the filter controls directly; the collapse toggle only appears at the
    // narrow-sheet breakpoint, so exercise the controls that are actually visible here.
    await expect(list.locator('#proposal-list-controls')).toBeVisible();
    await list.locator('#proposal-filter-search').fill('North');
    await expect(list.locator('.proposal-list-item')).toHaveCount(1);
    await expect(list.locator('.proposal-list-title')).toHaveText('North park plan');

    await list.locator('#proposal-filter-search').fill('');
    await list.locator('#proposal-filter-type').selectOption('park');
    await expect(list.locator('.proposal-list-item')).toHaveCount(2);
    await list.locator('#proposal-sort').selectOption('created-asc');
    await expect(list.locator('.proposal-list-item').first().locator('.proposal-list-title')).toHaveText('North park plan');
    await expect(list.locator('.proposal-list-item').last().locator('.proposal-list-title')).toHaveText('South park plan');

    await list.locator('.proposal-source-btn[data-source="blockchain"]').click();
    await expect(list.locator('.proposal-source-btn[data-source="blockchain"]')).toHaveClass(/active/);
    await list.locator('.proposal-source-btn[data-source="local"]').click();
    await expect(list.locator('.proposal-list-item')).toHaveCount(2);
    await list.locator('.proposal-source-btn[data-source="server"]').click();
    await expect(list.locator('.proposal-source-btn[data-source="server"]')).toHaveClass(/active/);
    // Restore local source before deleting; deletion is offered only for locally held records.
    await list.locator('.proposal-source-btn[data-source="local"]').click();
    await list.locator('#proposal-filter-type').selectOption('all');
    await expect(list.locator('.proposal-list-item')).toHaveCount(3);
    const target = list.locator(`.proposal-list-item[data-proposal-id="${ids[2]}"]`);
    await target.locator('.proposal-delete-btn').click();
    await expect.poll(() => page.evaluate(id => (window as any).getProposalByIdOrHash(id) == null, ids[2])).toBe(true);
    await expect(list.locator('.proposal-list-item')).toHaveCount(2);
  });

  test('proposal details fork into editable terms while retaining the source, and share can export JSON', async ({ mockApi: page }) => {
    await openCity(page);
    await page.locator('#username-display').click();
    await page.locator('#username-input').fill('Fork author');
    await page.locator('#welcome-submit-btn').click();
    const sourceId = await page.evaluate(({ parcelId, geometry }) => (window as any).proposalStorage.addProposal({
      title: 'Original park terms', goal: 'park', author: 'Ada', lifecycleStatus: 'Active', offer: 100, cadastreParcelIds: [parcelId],
      geometry, structureProposal: { kind: 'park', geometry, applied: true },
    }), { parcelId: PARCEL_ID, geometry: PARCEL_GEOMETRY });
    await showProposal(page, sourceId);
    await expandProposalDetails(page);

    await page.locator('.btn-counterpropose-proposal').click();
    const createDialog = page.locator('.create-proposal-modal:visible');
    await expect(createDialog).toBeVisible();
    await expect(createDialog.locator('#proposalName')).toHaveValue('Original park terms');
    await expect.poll(async () => (await proposalState(page, sourceId)).title).toBe('Original park terms');
    await createDialog.locator('#proposalName').fill('Counterproposal with revised terms');
    await createDialog.locator('#proposalDescription').fill('Revised proposal terms for the same parcel.');
    await createDialog.locator('input[name="proposalLandUse"][value="park"]').check();
    await createDialog.locator('#createProposalSubmitButton').click();
    await expect(createDialog).toBeHidden({ timeout: 10000 });
    await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals()
      .some((proposal: any) => proposal.title === 'Counterproposal with revised terms' && Number(proposal.offer) === 100))).toBe(true);
    expect((await proposalState(page, sourceId)).title).toBe('Original park terms');

    await showProposal(page, sourceId);
    await page.locator('.btn-share-proposal').click();
    const shareDialog = page.locator('.share-modal-overlay');
    await expect(shareDialog).toBeVisible();
    const downloadPromise = page.waitForEvent('download');
    await shareDialog.getByRole('button', { name: 'Download', exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.json$/);
    await expect.poll(async () => (await proposalState(page, sourceId)).title).toBe('Original park terms');
  });

  test('minted proposal parcel history loads an ownership and consent timeline from the visible history row', async ({ mockApi: page }) => {
    await page.route(`**/parcels/${encodeURIComponent(PARCEL_ID)}/history`, route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        parcelUid: PARCEL_ID,
        anchor: { account: PROPOSAL_ACCOUNT, exists: true, mintedAt: '2026-08-12T10:00:00Z' },
        events: [
          { type: 'proposal_created', at: '2026-08-10T08:00:00Z', title: 'Parcel history proposal' },
          { type: 'proposal_acceptance', at: '2026-08-11T09:00:00Z', proposalId: 'proposal-42', owner: SOLANA_WALLET },
        ],
      }),
    }));
    await injectMockSolanaWallet(page, { publicKey: SOLANA_WALLET, providerName: 'phantom' });
    await openCity(page);
    await connectWalletByConnectorId(page, 'solana-phantom');
    await waitForBlockchainRuntime(page, ['SolanaMarketClient', 'SolanaMarketBridge', 'SolanaChainDataLoader', 'solanaWeb3']);
    await installMarketRpcFixture(page);
    const proposalId = await page.evaluate((data) => (window as any).proposalStorage.addProposal({
      title: 'Parcel history proposal', goal: 'park', lifecycleStatus: 'Active', cadastreParcelIds: [data.parcelId],
      isMinted: true, nft: { chain: 'solana-devnet', contract: data.program, tokenId: data.account },
    }), { parcelId: PARCEL_ID, program: PARCEL_PROGRAM, account: PROPOSAL_ACCOUNT });
    await showProposal(page, proposalId);
    await expandProposalDetails(page);

    const history = page.locator('.proposal-parcel-history-card');
    await expect(history).toBeVisible();
    await history.locator(`[data-parcel-history="${PARCEL_ID}"] summary`).click();
    await expect(history.locator('[data-history-type="proposal_acceptance"]')).toContainText('Owner said yes');
    await expect(history.locator('.parcel-history-anchor')).toContainText('Anchored on chain since');
  });

  test('stacked proposals open the visible side-by-side parcel comparison', async ({ mockApi: page }) => {
    await openCity(page);
    await page.evaluate(({ parcelId, geometry }) => {
      const w = window as any;
      w.proposalStorage.addProposal({ title: 'Compare park plan', goal: 'park', lifecycleStatus: 'Active', cadastreParcelIds: [parcelId], geometry, applied: true });
      w.proposalStorage.addProposal({ title: 'Compare square plan', goal: 'square', lifecycleStatus: 'Active', cadastreParcelIds: [parcelId], geometry, applied: true });
      w.updateProposalLayer();
    }, { parcelId: PARCEL_ID, geometry: PARCEL_GEOMETRY });
    await clickMapPoint(page, 15.9822, 45.80025);

    const stack = page.locator('#drill-stack-panel');
    await expect(stack.locator('.drill-stack-compare')).toBeVisible();
    await stack.locator('.drill-stack-compare').click();
    const comparison = page.locator('#parcel-compare-dialog');
    await expect(comparison).toBeVisible();
    await expect(comparison).toContainText('Compare park plan');
    await expect(comparison).toContainText('Compare square plan');
  });
});
