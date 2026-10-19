import { test, expect } from '../helpers/fixtures';
import { openCity, PARCEL_ID } from '../helpers/runtime';

test('modeled totals require known land value and keep their ETH denomination', async ({ mockApi: page }) => {
  await openCity(page);
  const id = await page.evaluate(async parcelId => {
    const w = window as any;
    await w.i18n.setLanguage('en');
    const agent = w.createAgent();
    agent.name = 'Valuation preview';
    agent.ethBalance = 100;
    w.agentStorage.addAgent(agent);
    w.PersistentStorage.setItem(`parcel_${parcelId}_owner`, agent.id);
    w.ethUsdEstimate = 4000;
    // Exercise the dialog's handling of an unavailable calculation and a different active chain.
    w.calculatePortfolioValue = async () => NaN;
    w.getChainCurrencySymbol = () => 'SOL';
    await w.showAgentDialog(agent.id);
    return agent.id;
  }, PARCEL_ID);
  const dialog = page.locator('.agent-dialog-modal');
  await expect(dialog.locator('[data-agent-portfolio-value]')).toHaveText('-');
  await expect(dialog.locator('[data-agent-total-wealth]')).toHaveAttribute('data-portfolio-value', '');
  await expect(dialog.locator('[data-agent-total-wealth]')).toHaveText('-');
  await expect(dialog.locator('[data-agent-portfolio-basis]')).toHaveText('Land model: USD 200/m², converted at USD 4000 per ETH.');
  await expect(dialog).toContainText('Modeled land value');
  await expect(dialog).toContainText('Modeled total');

  await dialog.locator('.agent-dialog-modal-close').click();
  await page.evaluate(async agentId => {
    const w = window as any;
    w.calculatePortfolioValue = async () => 17;
    await w.showAgentDialog(agentId);
  }, id);
  await expect(dialog.locator('[data-agent-portfolio-value]')).toContainText('17');
  await expect(dialog.locator('[data-agent-portfolio-value]')).toContainText('ETH');
  await expect(dialog.locator('[data-agent-portfolio-value]')).not.toContainText('SOL');
  await expect(dialog.locator('[data-agent-total-wealth]')).toContainText('117');
  await expect(dialog.locator('[data-agent-total-wealth]')).toContainText('ETH');
});

test('agent profiles keep connected-wallet observations out of other agents', async ({ mockApi: page }) => {
  await openCity(page);
  const ids = await page.evaluate(async parcelId => {
    const w = window as any;
    await w.i18n.setLanguage('en');
    w.__profileWalletCalls = 0;
    w.walletManager = { getState: () => ({ status: 'connected', accounts: ['0x1111111111111111111111111111111111111111'], chainId: '0x1' }), getProvider: () => ({}) };
    w.solanaWalletManager = { getState: () => ({ status: 'disconnected', accounts: [] }) };
    w.ContractsLoader = {};
    w.ethers ||= {};
    w.ChainDataLoader = {
      resolveContractAddress: async (_chain: string, name: string) => name === 'ParcelNFT' ? 'parcel-contract' : null,
      getParcelsFromChain: () => {
        w.__profileWalletCalls += 1;
        return new Promise(resolve => { w.__resolveProfileParcels = resolve; });
      }
    };
    w.refreshUserEthBalanceDisplay = () => {};
    w.calculatePortfolioValue = async () => 3;
    const other = w.createAgent();
    other.name = 'Local model agent';
    w.agentStorage.addAgent(other);
    w.PersistentStorage.setItem(`parcel_${parcelId}_owner`, other.id);
    // A prior user-controlled role must not make this other agent inherit transient wallet data.
    w.agentWalletObservations[other.id] = { scope: { chainId: '0x1', walletAddress: '0x1111111111111111111111111111111111111111' }, contractAddress: 'parcel-contract', parcelIds: ['old-wallet-parcel'] };
    const user = w.createAgent();
    user.name = 'Wallet profile';
    user.userControlled = true;
    w.agentStorage.addAgent(user);
    await w.showAgentDialog(other.id);
    return { user: user.id, other: other.id };
  }, PARCEL_ID);
  const dialog = page.locator('.agent-dialog-modal');
  await expect(dialog.locator('[data-list-type="parcels"] .parcel-item')).toHaveCount(1);
  await expect(dialog.locator('[data-agent-parcels-basis]')).toHaveText('Parcels assigned to this agent in the local model.');
  await expect(dialog).toContainText('Linked parcels (1)');
  await expect(dialog).toContainText('Recorded acceptances (0)');
  expect(await page.evaluate(() => (window as any).__profileWalletCalls)).toBe(0);
  await dialog.locator('.agent-dialog-modal-close').click();
  await page.evaluate(id => (window as any).showAgentDialog(id), ids.user);
  await expect.poll(() => page.evaluate(() => (window as any).__profileWalletCalls)).toBe(1);
  await expect(dialog.locator('[data-agent-parcels-basis]')).toContainText('parcel NFTs observed in the connected wallet');
  await dialog.locator('.agent-dialog-modal-close').click();
  await page.evaluate(id => (window as any).showAgentDialog(id), ids.other);
  await page.evaluate(async () => {
    const w = window as any;
    const pending = eval('Array.from(agentDialogFetchPromises.values())') as any[];
    w.__resolveProfileParcels([{ parcelId: 'viewer-wallet-parcel' }]);
    await Promise.all(pending.map(entry => entry.promise));
  });
  await expect(dialog.locator('[data-list-type="parcels"] .parcel-item')).toHaveCount(1);
  await expect(dialog).not.toContainText('viewer-wallet-parcel');
  expect(await page.evaluate(() => (window as any).__profileWalletCalls)).toBe(1);
});

test('wallet profile replaces observations across accounts, networks and disconnects', async ({ mockApi: page }) => {
  await openCity(page);
  const id = await page.evaluate(async parcelId => {
    const w = window as any;
    await w.i18n.setLanguage('en');
    w.__walletProfileState = { status: 'connected', accounts: ['0x1111111111111111111111111111111111111111'], chainId: '0x1' };
    w.__walletProfileListeners = new Set();
    w.__walletProfileRequests = [];
    w.walletManager = {
      getState: () => w.__walletProfileState, getProvider: () => ({}),
      on: (event: string, fn: () => void) => { if (event === 'stateChanged') w.__walletProfileListeners.add(fn); return () => w.__walletProfileListeners.delete(fn); }
    };
    w.solanaWalletManager = { getState: () => ({ status: 'disconnected', accounts: [] }) };
    w.ContractsLoader = {}; w.ethers ||= {};
    w.ChainDataLoader = {
      resolveContractAddress: async (_chain: string, name: string) => name === 'ParcelNFT' ? 'parcel-contract' : null,
      getParcelsFromChain: (wallet: string, chain: string) => new Promise(resolve => w.__walletProfileRequests.push({ wallet, chain, resolve }))
    };
    w.refreshUserEthBalanceDisplay = () => {};
    w.calculatePortfolioValue = async () => 3;
    const user = w.createAgent(); user.name = 'Scoped wallet profile'; user.userControlled = true;
    w.agentStorage.addAgent(user);
    w.PersistentStorage.setItem(`parcel_${parcelId}_owner`, user.id);
    await w.showAgentDialog(user.id);
    return user.id;
  }, PARCEL_ID);
  const resolveRequest = async (index: number, parcelIds: string[]) => {
    await page.evaluate(async ({ index, parcelIds }) => {
      const w = window as any;
      const pending = eval('Array.from(agentDialogFetchPromises.values())') as any[];
      w.__walletProfileRequests[index].resolve(parcelIds.map(parcelId => ({ parcelId })));
      await Promise.all(pending.map(entry => entry.promise));
    }, { index, parcelIds });
  };
  const dialog = page.locator('.agent-dialog-modal');
  const parcelItems = dialog.locator('[data-list-type="parcels"] .parcel-item');
  await expect.poll(() => page.evaluate(() => (window as any).__walletProfileRequests.length)).toBe(1);
  await resolveRequest(0, ['wallet-a-parcel']);
  await expect(parcelItems).toHaveCount(2);
  expect(await page.evaluate(id => (window as any).agentWalletObservations[id].parcelIds, id)).toEqual(['wallet-a-parcel']);
  const fetchedAt = await page.evaluate(id => (window as any).agentDialogCache[id].lastFetchedAt, id);
  await dialog.locator('.agent-dialog-modal-close').click();
  await page.evaluate(id => (window as any).showAgentDialog(id), id);
  expect(await page.evaluate(id => (window as any).agentDialogCache[id].lastFetchedAt, id)).toBe(fetchedAt);
  expect(await page.evaluate(() => (window as any).__walletProfileRequests.length)).toBe(1);

  // Reopening under another account must not render the old account's cached list.
  await dialog.locator('.agent-dialog-modal-close').click();
  await page.evaluate(async id => {
    const w = window as any;
    w.__walletProfileState.accounts = ['0x2222222222222222222222222222222222222222'];
    await w.showAgentDialog(id);
  }, id);
  await expect.poll(() => page.evaluate(() => (window as any).__walletProfileRequests.length)).toBe(2);
  await expect(parcelItems).toHaveCount(1);
  await expect(dialog).not.toContainText('wallet-a-parcel');
  expect(await page.evaluate(id => (window as any).getAgentOwnedParcels(id), id)).toEqual([PARCEL_ID]);
  await resolveRequest(1, []);
  expect(await page.evaluate(id => (window as any).agentWalletObservations[id].parcelIds, id)).toEqual([]);
  await expect(parcelItems).toHaveCount(1);

  // A network change in the open dialog starts a new observation; a subsequent disconnect invalidates it.
  await page.evaluate(() => {
    const w = window as any;
    w.__walletProfileState.chainId = '0x2';
    w.__walletProfileListeners.forEach((fn: () => void) => fn());
  });
  await expect.poll(() => page.evaluate(() => (window as any).__walletProfileRequests.length)).toBe(3);
  await page.evaluate(() => {
    const w = window as any;
    w.__walletProfileState = { status: 'disconnected', accounts: [], chainId: '0x2' };
    w.__walletProfileListeners.forEach((fn: () => void) => fn());
  });
  await resolveRequest(2, ['late-network-parcel']);
  await expect(parcelItems).toHaveCount(1);
  await expect(dialog).not.toContainText('late-network-parcel');
  expect(await page.evaluate(id => (window as any).buildAgentOwnedParcelIndex().get(id), id)).toEqual([PARCEL_ID]);
  await expect(dialog.locator('[data-agent-total-wealth]')).toHaveText('-');
});
