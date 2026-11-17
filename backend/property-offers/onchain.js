import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { Connection } from '@solana/web3.js';
import { canonicalBytes } from '../cid.js';
const require = createRequire(import.meta.url);
export const client = require('../../frontend/js/solana/property-offer-client.js').configure({ web3: require('@solana/web3.js') });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw Object.assign(new Error(message), { status: 422, code: 'offer-chain-mismatch' }); };
export function validateOfferAccount(row, account) {
    const c = row.content;
    const expected = client.getOfferPda(row.cid, c.proposer)[0].toBase58();
    if (!account || account.address !== expected || account.cid !== row.cid || account.maker !== c.proposer || account.lens !== c.lens
        || account.side.toLowerCase() !== c.direction || account.priceLamports !== BigInt(c.priceLamports)
        || account.deadline !== BigInt(Math.floor(Date.parse(c.expiresAt) / 1000)) || account.termsHash !== hash(canonicalBytes(c))) fail('The Solana account does not match the published offer.');
    if (c.direction === 'sell' && Buffer.from(client.payoutScheduleHash(c.payouts)).toString('hex') !== account.payoutsHash) fail('The sale payout schedule differs from the offer.');
    if (!['Open', 'Accepted', 'Settled', 'Cancelled', 'Expired'].includes(account.status)) fail('Unknown offer status.');
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
        return validateOfferAccount(row, value);
    } };
}
export function mirrorOfferAccount(row, account, cluster) {
    validateOfferAccount(row, account);
    const payouts = account.payouts.map(p => ({ recipient: p.recipient, lamports: String(p.lamports) }));
    const onchain = { chain: 'solana', cluster, programId: client.constants.PROPERTY_OFFER_PROGRAM_ID, account: account.address,
        status: account.status.toLowerCase(), buyer: account.buyer, seller: account.seller, escrowLamports: String(account.escrowLamports),
        priceLamports: String(account.priceLamports), decisionAttestation: account.decisionAttestation, payouts, observedAt: new Date().toISOString() };
    const acceptance = account.acceptedAt > 0n ? { buyer: account.buyer, seller: account.seller, payouts, attestation: account.decisionAttestation } : null;
    return { onchain, acceptance };
}
