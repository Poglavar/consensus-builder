// Exercise qualified profile links with local, published-row and chain-token collisions.
import { test, expect } from '../helpers/fixtures';
import { openCity, PARCEL_ID } from '../helpers/runtime';

test('profile offers retain authored whole-proposal amounts without a pending-money total', async ({ mockApi: page }) => {
  await openCity(page);
  await page.evaluate(async parcelId => {
    const w = window as any;
    await w.i18n.setLanguage('en');
    const records = [
      { title: 'Recorded consideration', offer: 125, offerCurrency: 'EUR', decayEnabled: true, decayPercent: 50 },
      { title: 'Explicit zero offer', offer: 0, offerCurrency: 'USDC' },
      { title: 'Unknown consideration', offer: null, budget: 900, budgetCurrency: 'ETH', ethBalance: 1e18 },
      { title: 'Unknown currency', offer: 75, currency: 'ETH' },
      { title: 'Nonbinding vote', kind: 'owner-vote', offer: null }
    ];
    const agent = w.createAgent();
    agent.name = 'Offer display preview';
    agent.proposalsCreated = records.map((record, index) => w.proposalStorage.addProposal({
      proposalId: `p-profile-offer-${index}`, kind: 'owner-deal', lifecycleStatus: 'Active', cadastreParcelIds: [parcelId], ...record
    }));
    w.agentStorage.addAgent(agent);
    w.getChainCurrencySymbol = () => 'SOL';
    await w.showAgentDialog(agent.id);
  }, PARCEL_ID);
  const dialog = page.locator('.agent-dialog-modal');
  await expect(dialog.locator('[data-agent-pending-amount]')).toHaveCount(0);
  const created = dialog.locator('[data-list-type="created"]');
  const row = (title: string) => created.locator('.agent-dialog-proposal-item').filter({ hasText: title });
  await expect(row('Recorded consideration').locator('.proposal-offer')).toHaveText('Original full-proposal offer: 125 EUR');
  await expect(row('Explicit zero offer').locator('.proposal-offer')).toHaveText('Original full-proposal offer: 0 USDC');
  for (const title of ['Unknown consideration', 'Unknown currency']) {
    await expect(row(title).locator('.proposal-offer')).toHaveText('Original offer not recorded');
    await expect(row(title).locator('.proposal-offer-amount')).toHaveCount(0);
  }
  await expect(row('Nonbinding vote').locator('.proposal-offer')).toHaveCount(0);
  await expect(created.locator('.proposal-offer').filter({ hasText: 'SOL' })).toHaveCount(0);
});

test('profile chain links preserve their location and never open a colliding local draft', async ({ mockApi: page }) => {
  await openCity(page);
  const ids = await page.evaluate(async parcelId => {
    const w = window as any;
    await w.i18n.setLanguage('en');
    const draftId = w.proposalStorage.addProposal({ proposalId: '77', title: 'Unrelated numeric draft', cadastreParcelIds: [parcelId], kind: 'proposal', lifecycleStatus: 'Active' });
    const chainId = w.proposalStorage.addProposal({ proposalId: 'p-chain-profile', title: 'Observed chain design', cadastreParcelIds: [parcelId], kind: 'proposal', lifecycleStatus: 'Active', isMinted: true, onchain: { chainId: '0x1', contractAddress: '0xabc', proposalId: '77' } });
    const rowId = w.proposalStorage.addProposal({ proposalId: 'p-row-profile', serverProposalId: '88', title: 'Unrelated published row', cadastreParcelIds: [parcelId], kind: 'proposal', lifecycleStatus: 'Active' });
    const agent = w.createAgent(); agent.name = 'Proposal link preview'; agent.userControlled = true; agent.proposalsCreated = [draftId, '88'];
    w.agentStorage.addAgent(agent);
    w.walletManager = { getState: () => ({ status: 'connected', accounts: ['0x1111111111111111111111111111111111111111'], chainId: '0x1' }), getProvider: () => ({}) };
    w.solanaWalletManager = { getState: () => ({ status: 'disconnected', accounts: [] }) };
    w.ContractsLoader = {}; w.ethers ||= {};
    w.ChainDataLoader = {
      resolveContractAddress: async (_chain: string, name: string) => name === 'ProposalNFT' ? '0xabc' : null,
      getProposalsFromChain: async () => [
        { proposalId: '77', cadastreParcelIds: [parcelId], status: 'Active', title: 'Observed chain design' },
        // A chain response without importable parcel/site data stays an unloaded qualified link.
        { proposalId: '99', cadastreParcelIds: [], status: 'Active' }
      ],
      getProposalsAffectingParcels: async () => ({ accepted: ['77'], pending: [] })
    };
    w.refreshUserEthBalanceDisplay = () => {};
    w.calculatePortfolioValue = async () => 0;
    w.__profileFocused = [];
    w.selectAndHighlightProposal = (id: string) => w.__profileFocused.push(id);
    w.__profileChainReads = [];
    w.handleChainProposalRoute = (ref: any) => w.__profileChainReads.push(ref);
    await w.showAgentDialog(agent.id);
    return { agent: agent.id, draftId, chainId, rowId };
  }, PARCEL_ID);
  const dialog = page.locator('.agent-dialog-modal');
  const created = dialog.locator('[data-list-type="created"]');
  await expect(created.locator('.agent-dialog-proposal-item')).toHaveCount(4);
  await expect(created).toContainText('Unrelated numeric draft (Local ID 77)');
  await expect(created).toContainText('Observed chain design');
  await expect(created).toContainText('Local proposal record unavailable');
  await expect(created).toContainText('Local ID 88');
  await expect(created).not.toContainText('Unrelated published row');
  await expect(created).toContainText('Chain proposal not loaded');
  await expect(created).toContainText('evm / 0x1 · 0xabc · 99');
  await expect(created).not.toContainText('(deleted)');
  const accepted = dialog.locator('[data-list-type="accepted"]');
  await expect(accepted).toContainText('Observed chain design');
  await expect(accepted).not.toContainText('Unrelated numeric draft');
  await accepted.locator('.agent-dialog-proposal-item').click();
  expect(await page.evaluate(() => (window as any).__profileFocused)).toEqual([ids.chainId]);
  await page.evaluate(id => (window as any).showAgentDialog(id), ids.agent);
  await created.locator('.agent-dialog-proposal-item').filter({ hasText: 'Chain proposal not loaded' }).click();
  expect(await page.evaluate(() => (window as any).__profileChainReads)).toEqual([{ chainType: 'evm', chainId: '0x1', contract: '0xabc', tokenId: '99' }]);
  expect(await page.evaluate(id => (window as any).proposalStorage.getProposal(id).title, ids.draftId)).toBe('Unrelated numeric draft');
});
