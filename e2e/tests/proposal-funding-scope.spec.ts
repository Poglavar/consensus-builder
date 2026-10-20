// Exercise the real funding readers against scoped RPC evidence and incompatible proposal references.
import { test, expect } from '../helpers/fixtures';
import { openCity, PARCEL_ID, showProposal } from '../helpers/runtime';
import { waitForBlockchainRuntime } from '../helpers/blockchain';
import { installSolanaProposalAccount } from '../helpers/solana-proposal-account';

const ACCOUNT = '7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT';
const PROGRAM = '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg';

test('funding reads require a qualified deployment and verified RPC account evidence', async ({ mockApi: page }) => {
  await openCity(page);
  await waitForBlockchainRuntime(page, ['SolanaAcceptanceClient', 'SolanaPledgeBridge', 'SolanaMarketBridge', 'solanaWeb3']);
  const records = await page.evaluate(({ account, program, parcelId }) => {
    const w = window as any;
    const connection = {
      getAccountInfo: async () => null,
      getProgramAccounts: async () => [],
      getMultipleAccountsInfo: async (keys: unknown[]) => keys.map(() => null),
      getSignaturesForAddress: async () => [],
    };
    w.__fundingScopeConnection = connection;
    w.__fundingScopeClusters = [];
    w.SolanaChainDataLoader.getConnection = () => connection;
    const verifiedConnection = w.SolanaChainDataLoader.getVerifiedConnection;
    w.SolanaChainDataLoader.getVerifiedConnection = (cluster: string) => {
      w.__fundingScopeClusters.push(cluster);
      return verifiedConnection(cluster);
    };
    w.solanaWalletManager.getCluster = () => 'mainnet-beta';
    w.solanaWalletManager.getProvider = () => null;
    return ['solana', 'solana-mainnet-beta', 'solana-devnet', 'solana-devnet'].map((chain, i) =>
      w.proposalStorage.addProposal({ proposalId: `p-funding-scope-${i}`, title: `Funding scope ${i}`,
        goal: 'park', cadastreParcelIds: [parcelId], lifecycleStatus: 'Active', isMinted: true,
        nft: { chain, contract: i === 2 ? account : program, tokenId: account } }));
  }, { account: ACCOUNT, program: PROGRAM, parcelId: PARCEL_ID });
  await installSolanaProposalAccount(page, { proposal: ACCOUNT, owner: ACCOUNT, status: 0 });

  for (const id of records.slice(0, 3)) {
    await showProposal(page, id);
    await expect(page.locator('.proposal-pledge-summary')).toHaveCount(0);
    await expect(page.locator('.proposal-market-summary')).toHaveCount(0);
  }
  await showProposal(page, records[3]);
  const panel = page.locator('#proposal-details-panel');
  const expand = panel.getByRole('button', { name: 'Expand', exact: true });
  if (await expand.isVisible()) await expand.click();
  await panel.locator('details[data-proposal-section="funding"]').evaluate((element: HTMLDetailsElement) => { element.open = true; });
  await expect(panel.locator('[data-funding="donated"]')).toHaveText('0 USDC · 0 donors');
  const verifiedClusters = await page.evaluate(() => (window as any).__fundingScopeClusters as string[]);
  expect(verifiedClusters.length).toBeGreaterThanOrEqual(2);
  expect(verifiedClusters.every(cluster => cluster === 'devnet')).toBe(true);

  await page.evaluate(() => { (window as any).__fundingScopeConnection.getGenesisHash = async () => 'another-network'; });
  await showProposal(page, records[3]);
  await expect(panel.locator('[data-funding="donated"]')).toHaveText('Unavailable');
  await expect(panel.locator('[data-funding="pledged"]')).toHaveText('Unavailable');

  await page.evaluate(async ({ account, wrongOwner }) => {
    const w = window as any;
    const connection = w.__fundingScopeConnection;
    connection.getGenesisHash = async () => 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
    const original = connection.getAccountInfo;
    connection.getAccountInfo = async (key: any) => {
      const info = await original(key);
      return key.toBase58() === account ? { ...info, owner: new w.solanaWeb3.PublicKey(wrongOwner) } : info;
    };
  }, { account: ACCOUNT, wrongOwner: ACCOUNT });
  await showProposal(page, records[3]);
  await expect(panel.locator('[data-funding="donated"]')).toHaveText('Unavailable');
  const errors = await page.evaluate(async account => {
    const w = window as any;
    return Promise.all([w.SolanaMarketBridge, w.SolanaPledgeBridge].map(async bridge => {
      try { await bridge.readSummary(account); return 'unexpected success'; }
      catch (error) { return String(error); }
    }));
  }, ACCOUNT);
  expect(errors.every(error => error.includes('another program'))).toBe(true);
});
