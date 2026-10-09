import { test, expect } from '../helpers/fixtures';
import { openCity, proposalState, showProposal, PARCEL_ID } from '../helpers/runtime';
import { connectWalletByConnectorId, injectMockSolanaWallet, waitForBlockchainRuntime } from '../helpers/blockchain';

const WALLET = '7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT';
const PROPOSAL = '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg';
const BENEFICIARY = '4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1';
const PROPOSAL_NFT_PROGRAM = '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg';

type ActionCase = {
  action: 'pledge' | 'revokePledge' | 'releaseDonations' | 'fulfillPledge' | 'refundMyDonations' | 'voidPledge';
  lifecycle: 'Active' | 'Executed' | 'Cancelled';
  button: string;
  success: string;
  instruction: string;
};

async function installSupportRpcFixture(page: import('@playwright/test').Page, action: ActionCase['action']): Promise<void> {
  await page.evaluate(({ proposal, wallet, beneficiary, action }) => {
    const w = window as any;
    const client = w.SolanaPledgeClient;
    const web3 = w.solanaWeb3;
    const proposalKey = new web3.PublicKey(proposal);
    const walletKey = new web3.PublicKey(wallet);
    const beneficiaryKey = new web3.PublicKey(beneficiary);
    const mintKey = new web3.PublicKey(client.constants.USDC_DEVNET_MINT);
    const accounts = new Map<string, Uint8Array>();
    const concat = (parts: Uint8Array[]) => {
      const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
      let offset = 0;
      for (const part of parts) { result.set(part, offset); offset += part.length; }
      return result;
    };
    const writeU64 = (value: bigint) => {
      const result = new Uint8Array(8);
      new DataView(result.buffer).setBigUint64(0, value, true);
      return result;
    };
    const add = (address: any, data: Uint8Array) => accounts.set(address.toBase58(), data);
    const [book] = client.getPledgeBookPda(proposalKey);
    const [escrow] = client.getDonationEscrowPda(proposalKey);
    const bookData = concat([
      Uint8Array.from(client.ACCOUNT_DISCRIMINATORS.PledgeBook), proposalKey.toBytes(), beneficiaryKey.toBytes(), mintKey.toBytes(),
      writeU64(1_000_000n), writeU64(0n), writeU64(0n), writeU64(1n), writeU64(1n), writeU64(0n), Uint8Array.of(1),
    ]);
    const commitmentData = concat([
      Uint8Array.from(client.ACCOUNT_DISCRIMINATORS.PledgeCommitment), book.toBytes(), proposalKey.toBytes(), walletKey.toBytes(),
      writeU64(1_000_000n), Uint8Array.of(client.constants.PLEDGE_ACTIVE, 1, 1),
    ]);
    const escrowData = concat([
      Uint8Array.from(client.ACCOUNT_DISCRIMINATORS.DonationEscrow), proposalKey.toBytes(), beneficiaryKey.toBytes(), mintKey.toBytes(),
      client.getAssociatedTokenAddress(escrow, mintKey).toBytes(), writeU64(1_000_000n), writeU64(0n), writeU64(0n),
      writeU64(1n), writeU64(1n), Uint8Array.of(0, 1),
    ]);
    const donationId = new Uint8Array(32); donationId[31] = 7;
    const donationData = concat([
      Uint8Array.from(client.ACCOUNT_DISCRIMINATORS.DonationPosition), escrow.toBytes(), walletKey.toBytes(), donationId,
      writeU64(1_000_000n), Uint8Array.of(0, 1),
    ]);
    if (action !== 'pledge') {
      add(book, bookData);
      if (['revokePledge', 'fulfillPledge', 'voidPledge'].includes(action)) {
        add(client.getPledgeCommitmentPda(book, walletKey)[0], commitmentData);
      }
    }
    if (['releaseDonations', 'refundMyDonations'].includes(action)) add(escrow, escrowData);
    const donationPosition = client.getDonationPositionPda(escrow, walletKey, donationId)[0];

    const events: string[] = [];
    const connection = {
      getAccountInfo: async (key: any) => {
        const data = accounts.get(key.toBase58());
        return data ? { data } : null;
      },
      getProgramAccounts: async () => action === 'refundMyDonations'
        ? [{ pubkey: donationPosition, account: { data: donationData } }]
        : [],
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
      w.__proposalSupportInstructionData = (transaction.instructions || []).map((instruction: any) => Array.from(instruction.data || []));
      transaction.serialize = () => new Uint8Array([1, 2, 3]);
      return transaction;
    };
    w.__proposalSupportRpcEvents = events;
    w.SolanaChainDataLoader.getConnection = () => connection;
  }, { proposal: PROPOSAL, wallet: WALLET, beneficiary: BENEFICIARY, action });
}

const cases: ActionCase[] = [
  { action: 'pledge', lifecycle: 'Active', button: 'Pledge USDC', success: 'boosting this proposal with 1 of USDC', instruction: 'set_pledge' },
  { action: 'revokePledge', lifecycle: 'Active', button: 'Revoke my pledge', success: 'pledge was revoked', instruction: 'revoke_pledge' },
  { action: 'releaseDonations', lifecycle: 'Executed', button: 'Release donations', success: 'donations were released', instruction: 'release_donations' },
  { action: 'fulfillPledge', lifecycle: 'Executed', button: 'Fulfill my pledge', success: 'pledged USDC was transferred', instruction: 'fulfill_pledge' },
  { action: 'refundMyDonations', lifecycle: 'Cancelled', button: 'Refund my donations', success: 'refundable donations were returned', instruction: 'refund_donation' },
  { action: 'voidPledge', lifecycle: 'Cancelled', button: 'Clear my pledge', success: 'pledge was cleared', instruction: 'void_pledge' },
];

test.describe('Proposal support settlement @features', () => {
  for (const row of cases) {
    test(`${row.action} is available in its lifecycle and confirms the matching Solana instruction`, async ({ mockApi: page }) => {
      await injectMockSolanaWallet(page, { publicKey: WALLET, providerName: 'phantom' });
      await openCity(page);
      await connectWalletByConnectorId(page, 'solana-phantom');
      await waitForBlockchainRuntime(page, ['SolanaPledgeClient', 'SolanaPledgeBridge', 'SolanaChainDataLoader', 'solanaWeb3']);
      const proposalId = await page.evaluate(({ parcelId, account, lifecycle, program }) => (window as any).proposalStorage.addProposal({
        title: `Support settlement ${lifecycle}`, goal: 'park', lifecycleStatus: lifecycle, cadastreParcelIds: [parcelId],
        isMinted: true, nft: { chain: 'solana-devnet', contract: program, tokenId: account },
      }), { parcelId: PARCEL_ID, account: PROPOSAL, lifecycle: row.lifecycle, program: PROPOSAL_NFT_PROGRAM });
      await installSupportRpcFixture(page, row.action);
      await showProposal(page, proposalId);
      const expand = page.locator('#proposal-details-panel').getByRole('button', { name: 'Expand', exact: true });
      if (await expand.isVisible()) await expand.click();

      const actionArea = page.locator('.proposal-support-actions');
      const button = actionArea.getByRole('button', { name: new RegExp(row.button) });
      await expect(button).toBeVisible({ timeout: 10000 });
      if (row.action === 'pledge') {
        await button.click();
        const dialog = page.locator('#proposalBoostOverlay');
        await dialog.locator('#proposalBoostAmount').fill('1');
        await dialog.locator('[data-support-submit]').click();
      } else {
        await button.click();
      }

      const alert = page.locator('.cb-confirm-overlay');
      await expect(alert.locator('.cb-confirm-message')).toContainText(row.success, { timeout: 10000 });
      expect(await page.evaluate(() => (window as any).__proposalSupportRpcEvents)).toEqual(['send', 'confirm']);
      const instructionData = await page.evaluate((name) => {
        const w = window as any;
        const discriminator = w.SolanaPledgeClient.IX_DISCRIMINATORS[name];
        return (w.__proposalSupportInstructionData as number[][]).some(data =>
          discriminator.every((byte: number, index: number) => data[index] === byte));
      }, row.instruction);
      expect(instructionData).toBe(true);
      await alert.getByRole('button', { name: 'OK', exact: true }).click();
      expect((await proposalState(page, proposalId)).lifecycleStatus).toBe(row.lifecycle);
    });
  }
});
