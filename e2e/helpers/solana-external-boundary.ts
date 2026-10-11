// Solana E2E transport boundary: preserve production account parsing and bridge logic while making RPC deterministic.
import type { Page } from '@playwright/test';

export const PROPOSAL_SOLANA_PROGRAM = '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg';
export const PARCEL_SOLANA_PROGRAM = '4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1';

/**
 * Keep the app's Solana loader, account parsers, cache, and bridge intact while replacing only
 * the RPC transport methods on the SDK connection the loader actually caches.
 */
export async function installSolanaExternalBoundary(
  page: Page,
  options: { parcelIds?: string[]; signature?: string } = {},
): Promise<void> {
  const parcelIds = options.parcelIds || [];
  const signature = options.signature || '5N2o4X1mockSignature';

  await page.route('**/contracts/addresses.json', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      solana: { ProposalNFT: PROPOSAL_SOLANA_PROGRAM, ParcelNFT: PARCEL_SOLANA_PROGRAM },
      'solana-devnet': { ProposalNFT: PROPOSAL_SOLANA_PROGRAM, ParcelNFT: PARCEL_SOLANA_PROGRAM },
    }),
  }));

  await page.evaluate(async ({ parcelIds, signature, proposalProgramId, parcelProgramId }) => {
    const w = window as typeof window & Record<string, any>;
    const loader = w.SolanaChainDataLoader;
    const client = w.SolanaAcceptanceClient;
    const web3 = w.solanaWeb3;
    if (!loader?.getConnection || !client || !web3) throw new Error('Solana runtime is unavailable');

    // getParcelMintStatuses closes over this same SDK Connection; keep the loader method intact.
    const connection = loader.getConnection('devnet');
    const accounts = new Map<string, any>();
    const encodedStrings = (values: string[]) => {
      const encoder = new TextEncoder();
      const chunks = values.map(value => {
        const bytes = encoder.encode(value);
        const length = new Uint8Array(4);
        new DataView(length.buffer).setUint32(0, bytes.length, true);
        return [length, bytes];
      }).flat();
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const body = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
      return body;
    };
    const parcelAccount = (parcelId: string) => {
      const strings = encodedStrings([parcelId, 'ipfs://parcel-anchor-metadata']);
      const data = new Uint8Array(8 + strings.length + 32);
      data.set(Uint8Array.from([33, 57, 133, 211, 91, 18, 74, 6]), 0);
      data.set(strings, 8);
      return { data, owner: new web3.PublicKey(parcelProgramId), lamports: 1, executable: false, rentEpoch: 0 };
    };
    const counterPda = client.getProposalCounterPda(proposalProgramId)[0].toBase58();
    const counter = new Uint8Array(16);
    counter.set(Uint8Array.from([143, 54, 21, 213, 173, 198, 231, 44]), 0);
    new DataView(counter.buffer).setBigUint64(8, 1n, true);
    accounts.set(counterPda, { data: counter, owner: new web3.PublicKey(proposalProgramId), lamports: 1, executable: false, rentEpoch: 0 });

    const addMintedParcelAccounts = () => {
      for (const parcelId of parcelIds) {
        const pda = client.getParcelPda(parcelId, parcelProgramId)[0].toBase58();
        accounts.set(pda, parcelAccount(parcelId));
      }
    };
    const events: string[] = [];
    connection.getAccountInfo = async (key: any) => accounts.get(key.toBase58()) || null;
    connection.getMultipleAccountsInfo = async (keys: any[]) => keys.map(key => accounts.get(key.toBase58()) || null);
    connection.getProgramAccounts = async () => [];
    connection.getLatestBlockhash = async () => ({
      blockhash: 'EkSnNWid2cvwEVnVx9aBqpiCpY1QoUW63D2Hp31e4gwJ', lastValidBlockHeight: 1000,
    });
    connection.simulateTransaction = async () => { events.push('simulate'); return { value: { err: null, logs: [] } }; };
    connection.sendRawTransaction = async () => { events.push('send'); addMintedParcelAccounts(); return signature; };
    connection.confirmTransaction = async () => { events.push('confirm'); return { value: { err: null } }; };
    const provider = w.solanaWalletManager?.getProvider?.();
    if (!provider) throw new Error('Active Solana wallet provider is unavailable');
    provider.signTransaction = async (transaction: any) => {
      events.push('sign');
      transaction.serialize = () => new Uint8Array([1, 2, 3]);
      return transaction;
    };
    w.__solanaExternalBoundaryEvents = events;
  }, { parcelIds, signature, proposalProgramId: PROPOSAL_SOLANA_PROGRAM, parcelProgramId: PARCEL_SOLANA_PROGRAM });
}
