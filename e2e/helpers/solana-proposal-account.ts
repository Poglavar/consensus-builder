// Add authentic proposal-account and network evidence to an existing local Solana RPC fixture.
import type { Page } from '@playwright/test';

const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

/**
 * Wrap the active RPC fixture with a valid Proposal-v3 account. Chain-backed proposal details
 * verify the proposal account before the market or support client can be exercised, so the
 * fixture adds only that account and leaves all other RPC reads with the installed boundary.
 */
export async function installSolanaProposalAccount(
  page: Page,
  options: { proposal: string; owner: string; status?: number },
): Promise<void> {
  await page.evaluate(({ proposal, owner, status, genesisHash }) => {
    const w = window as any;
    const web3 = w.solanaWeb3;
    const client = w.SolanaAcceptanceClient;
    const loader = w.SolanaChainDataLoader;
    if (!web3 || !client || !loader?.getConnection) throw new Error('Solana proposal runtime is unavailable');

    const proposalKey = new web3.PublicKey(proposal);
    const ownerKey = new web3.PublicKey(owner);
    const programKey = new web3.PublicKey(client.constants.PROPOSAL_NFT_PROGRAM_ID);
    const putU32 = (value: number) => {
      const bytes = new Uint8Array(4);
      new DataView(bytes.buffer).setUint32(0, value, true);
      return bytes;
    };
    const putU64 = (value: bigint) => {
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setBigUint64(0, value, true);
      return bytes;
    };
    const parts = [
      Uint8Array.from(client.ACCOUNT_DISCRIMINATORS.Proposal),
      putU64(42n), // proposal_id
      ownerKey.toBytes(),
      putU32(0), // parcel_ids
      Uint8Array.of(0), // is_conditional
      putU32(0), // image_uri
      Uint8Array.of(1), // acceptance_possible
      Uint8Array.of(status),
      putU64(0n), // sol_balance
      putU64(0n), // token_balance
      putU64(0n), // acceptance_count
      putU32(0), // accepted_parcels
      putU32(0), // lens
      Uint8Array.of(0), // bump
      Uint8Array.of(0), // verdict_may_execute
      new Uint8Array(32), // site_hash
      Uint8Array.of(0, 0, 3), // open_ground, open_ground_cleared, layout_version
    ];
    const proposalData = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      proposalData.set(part, offset);
      offset += part.length;
    }

    const connection = loader.getConnection('devnet');
    const getAccountInfo = connection.getAccountInfo.bind(connection);
    connection.getGenesisHash = async () => genesisHash;
    connection.getAccountInfo = async (key: any, ...args: any[]) => {
      if (key?.toBase58?.() === proposalKey.toBase58()) return { data: proposalData, owner: programKey };
      return getAccountInfo(key, ...args);
    };
  }, { ...options, status: options.status ?? 0, genesisHash: DEVNET_GENESIS_HASH });
}
