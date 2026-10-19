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
    w.agentDialogTempOwnership[other.id] = ['old-wallet-parcel'];
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
