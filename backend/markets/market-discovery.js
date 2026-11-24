import { createRequire } from 'node:module';
import { PublicKey } from '@solana/web3.js';
import { DEVNET_USDC_MINT } from '../solana/address-book.js';

const require = createRequire(import.meta.url);
const lmsr = require('../../frontend/js/solana/lmsr-client.js');
const bs58 = require('bs58').default || require('bs58');
lmsr.configure({ web3: require('@solana/web3.js') });
const PROGRAM_ID = lmsr.constants.PROGRAM_ID;

/** Discover every valid devnet-USDC LMSR account bound to the supplied agreement accounts.
 * The scan is one getProgramAccounts call (with discriminator, size and mint filters), not one
 * RPC read per agreement. Invalid individual accounts are ignored; RPC failures propagate.
 */
export async function discoverAgreementMarkets(connection, accounts, options = {}) {
    if (!connection?.getProgramAccounts) throw new Error('a Solana connection is required');
    const programId = options.programId || PROGRAM_ID;
    const wanted = new Set((accounts || []).map(value => new PublicKey(value).toBase58()));
    if (!wanted.size) return new Map();
    const rows = await connection.getProgramAccounts(new PublicKey(programId), {
        commitment: options.commitment || 'confirmed',
        filters: [
            { dataSize: lmsr.MARKET_SIZE },
            { memcmp: { offset: 0, bytes: bs58.encode(Uint8Array.from(lmsr.ACCOUNT_DISCRIMINATORS.LmsrMarket)) } },
            { memcmp: { offset: 73, bytes: DEVNET_USDC_MINT } }
        ]
    });
    const result = new Map([...wanted].map(account => [account, []]));
    for (const row of rows) {
        const address = row.pubkey?.toBase58?.() || String(row.pubkey);
        try {
            const market = lmsr.readMarketAccount(row.account, address, programId);
            if (market.stakeMint !== DEVNET_USDC_MINT || !wanted.has(market.proposal)) continue;
            result.get(market.proposal).push({ address, market });
        } catch (_) { /* an incompatible account must not hide valid markets */ }
    }
    for (const list of result.values()) list.sort((a, b) => (b.market.b > a.market.b ? 1 : b.market.b < a.market.b ? -1 : a.address.localeCompare(b.address)));
    return result;
}
