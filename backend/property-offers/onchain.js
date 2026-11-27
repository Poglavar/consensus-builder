// The server's own read of a property offer's Solana account (programs/property_offer v2): the index
// mirrors only an account it read itself and proved to carry the published terms, never a browser's
// claim about chain state.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { Connection } from '@solana/web3.js';
import { canonicalBytes } from '../cid.js';
const require = createRequire(import.meta.url);
export const client = require('../../frontend/js/solana/property-offer-client.js').configure({ web3: require('@solana/web3.js') });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw Object.assign(new Error(message), { status: 422, code: 'offer-chain-mismatch' }); };
export const termsHashOf = content => hash(canonicalBytes(content));
const sameLens = (chain, lens) => chain.threshold === lens.threshold && chain.members.length === lens.members.length && chain.members.every((member, i) => member === lens.members[i]);

/** The account carries exactly the published terms (the maker's lens and a sale's payouts included). */
export function validateOfferAccount(row, account) {
    const c = row.content;
    const expected = client.getOfferPda(row.cid, c.proposer)[0].toBase58();
    if (!account || account.address !== expected || account.cid !== row.cid || account.maker !== c.proposer
        || account.side.toLowerCase() !== c.direction || account.currency !== c.currency || account.price !== BigInt(c.price)
        || account.deadline !== BigInt(Math.floor(Date.parse(c.expiresAt) / 1000)) || account.termsHash !== termsHashOf(c)) fail('The Solana account does not match the published offer.');
    if (!sameLens(c.direction === 'buy' ? account.buyerLens : account.sellerLens, c.lens)) fail('The maker’s lens on Solana differs from the offer.');
    if (c.direction === 'sell' && (account.payouts.length !== c.payouts.length
        || account.payouts.some((payout, i) => payout.recipient !== c.payouts[i].recipient || payout.amount !== BigInt(c.payouts[i].amount)))) fail('The sale payout schedule differs from the offer.');
    if (!client.STATUS_NAMES.includes(account.status)) fail('Unknown offer status.');
    return account;
}
export function createOfferChain(cluster, env = process.env) {
    let endpoint;
    if (cluster === 'devnet') endpoint = env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
    else if (cluster === 'localnet' && env.SOLANA_LOCALNET_RPC_URL) {
        const url = new URL(env.SOLANA_LOCALNET_RPC_URL);
        if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) fail('Localnet must use a configured loopback RPC.');
        endpoint = url.href;
    } else fail('The server does not support this Solana network.');
    const connection = new Connection(endpoint, { commitment: 'confirmed', fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15000) }) });
    return { async read(row) {
        if (cluster === 'devnet' && await connection.getGenesisHash() !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG') fail('RPC network is not Solana devnet.');
        const value = await client.fetchPropertyOffer(connection, { cid: row.cid, maker: row.content.proposer });
        if (!value) fail('The offer account does not exist on this network.');
        return validateOfferAccount(row, value);
    } };
}

/**
 * The index's mirror of a validated account: { onchain, status, lensMembers } where lensMembers is
 * the maker's lens and the counterparty's once the account names it.
 */
export function mirrorOfferAccount(row, account, cluster, { now = () => new Date() } = {}) {
    validateOfferAccount(row, account);
    const lens = ({ members, threshold, confirmed, met }) => ({ members, threshold, confirmed, met });
    const status = account.status.toLowerCase();
    const onchain = { chain: 'solana', cluster, programId: client.constants.PROPERTY_OFFER_PROGRAM_ID, account: account.address, status,
        buyer: account.buyer, seller: account.seller, escrow: String(account.escrow), buyerLens: lens(account.buyerLens), sellerLens: lens(account.sellerLens),
        payouts: account.payouts.map(p => ({ recipient: p.recipient, amount: String(p.amount) })), observedAt: now().toISOString() };
    const lensMembers = [...new Set([...row.content.lens.members, ...account.buyerLens.members, ...account.sellerLens.members])];
    return { onchain, status, lensMembers };
}
