// Node signer adapter for property offers v2 (programs/property_offer): an MCP agent holding its own
// Solana keypair takes the steps a person takes in the browser's offer panel
// (frontend/js/solana/property-offer-bridge.js), on the same codecs: the maker creates the offer, the
// counterparty commits (naming its lens; a buyer pays into escrow), lens members confirm with a
// PropertyOfferConfirmation-v1 attestation, anyone executes once both lenses are met, the maker
// cancels while open, anyone expires after the deadline; and a lens member states a first holder
// (PropertyHolding-v1). Every step reads the chain account first and checks it against the published
// terms with the index's own check (property-offers/onchain.js), refuses before signing what the
// program would refuse, signs nothing on a replay, and then records the chain reference in the index
// through the injected `recordOnchain(ref, cid)` (createOnchainRecorder is the HTTP one).
import { createRequire } from 'node:module';
import { client, termsHashOf, validateOfferAccount } from '../property-offers/onchain.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const Offer = require('../../frontend/js/property-offer-record.js');
const Statements = require('../../frontend/js/solana/property-statements.js').configure({ web3 });

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const { PROPERTY_OFFER_PROGRAM_ID } = client.constants;
const deadlineOf = content => Math.floor(Date.parse(content.expiresAt) / 1000);
const refuse = message => { throw Object.assign(new Error(`${message}; nothing signed.`), { code: 'refused' }); };
const chainNow = async connection => connection.getBlockTime(await connection.getSlot('confirmed'));

async function network({ connection, keypair, cluster = 'devnet' }) {
    if (!connection?.getAccountInfo) throw new Error('a solana connection is required');
    if (!keypair?.publicKey) throw new Error('keypair is required');
    if (!['devnet', 'localnet'].includes(cluster)) throw new Error('Property offers currently support Solana devnet and localnet.');
    if (cluster === 'devnet' && await connection.getGenesisHash() !== DEVNET_GENESIS) throw new Error('The RPC network does not match Solana devnet.');
    return { connection, keypair, cluster, signer: keypair.publicKey.toBase58() };
}

/** The bridge's context(): the network, the program, the published CID and the offer address. */
async function context({ connection, keypair, row, cluster, recordOnchain }) {
    if (typeof recordOnchain !== 'function') throw new Error('recordOnchain (ref, cid) is required to index the confirmed step');
    if (!row?.cid || !row.content || Offer.cid(row.content) !== row.cid) throw new Error('The offer content does not match its published CID.');
    const net = await network({ connection, keypair, cluster: cluster || row.onchain?.cluster || 'devnet' });
    if (row.onchain?.cluster && row.onchain.cluster !== net.cluster) throw new Error(`The offer is indexed on ${row.onchain.cluster}, not ${net.cluster}.`);
    const program = await connection.getAccountInfo(new web3.PublicKey(PROPERTY_OFFER_PROGRAM_ID));
    if (!program?.executable) throw Object.assign(new Error('The property offer program is not deployed on this Solana network yet.'), { code: 'program-not-deployed' });
    const address = client.getOfferPda(row.cid, row.content.proposer)[0].toBase58();
    if (row.onchain?.account && row.onchain.account !== address) throw new Error('The chain address does not match the published offer.');
    return { ...net, row, recordOnchain, address };
}

/** null before create; otherwise the account, proven to carry the published terms. */
async function readChain(ctx) {
    const account = await client.fetchPropertyOffer(ctx.connection, { address: ctx.address });
    return account ? validateOfferAccount(ctx.row, account) : null;
}

async function send(ctx, instructions, sendAndConfirm) {
    const transaction = new web3.Transaction().add(...instructions);
    transaction.feePayer = ctx.keypair.publicKey;
    return sendAndConfirm(ctx.connection, transaction, [ctx.keypair], { commitment: 'confirmed' });
}

/** Read back, then index the reference (also on a replay, which re-syncs the index). */
async function persist(ctx, signature) {
    const chain = await readChain(ctx);
    const ref = { chain: 'solana', cluster: ctx.cluster, account: ctx.address, signature: signature ?? ctx.row.onchain?.signature ?? null };
    let indexed;
    try { indexed = await ctx.recordOnchain(ref, ctx.row.cid); }
    catch (cause) {
        throw Object.assign(new Error('The Solana step is on chain, but the index could not record it. Repeat the same step: it signs nothing again and retries the record.'),
            { cause, signature, ref });
    }
    return { signature, replayed: signature === null, account: ctx.address, status: chain?.status?.toLowerCase() ?? null, onchain: indexed?.onchain ?? null };
}

/** Read, plan (null = replay; throw = refuse), send, index. */
async function mutate({ sendAndConfirm = web3.sendAndConfirmTransaction, nowSeconds, ...options }, plan) {
    const ctx = await context(options);
    const chain = await readChain(ctx);
    if (!chain) refuse('Create this offer on Solana first');
    const instructions = await plan(ctx, chain, nowSeconds ?? await chainNow(ctx.connection));
    return persist(ctx, instructions ? await send(ctx, instructions, sendAndConfirm) : null);
}

const beforeDeadline = (chain, nowSeconds, what) => { if (BigInt(nowSeconds) > chain.deadline) refuse(`The offer deadline has passed; it can no longer be ${what}`); };
const executeIxs = (ctx, chain) => client.buildExecuteIxs({ offer: ctx.address, currency: chain.currency, recipients: chain.payouts.map(p => p.recipient), payer: ctx.signer });

/** The maker creates its published offer on Solana (a buyer pays the price into escrow). An existing account is a replay. */
export async function createOfferOnChain({ nowSeconds, sendAndConfirm = web3.sendAndConfirmTransaction, ...options } = {}) {
    const ctx = await context(options), content = ctx.row.content;
    if (ctx.signer !== content.proposer) refuse('Only the proposer can create this offer on Solana');
    if (await readChain(ctx)) return persist(ctx, null);
    if (deadlineOf(content) <= (nowSeconds ?? await chainNow(ctx.connection))) refuse(`The offer expired at ${content.expiresAt}`);
    const { instructions } = client.buildCreateIxs({ maker: ctx.signer, currency: content.currency, cid: ctx.row.cid, side: content.direction, termsHash: termsHashOf(content),
        price: content.price, deadline: deadlineOf(content), payouts: content.payouts || [], lens: content.lens.members, lensThreshold: content.lens.threshold });
    return persist(ctx, await send(ctx, instructions, sendAndConfirm));
}

/**
 * The counterparty commits: the seller of a buy offer names the payout schedule (default: all to
 * itself) and its optional lens; the buyer of a sell offer names its lens (required: who states the
 * seller holds the asset) and pays the price into escrow. Committed by this wallet already is a replay.
 */
export function commitOffer({ lens = { members: [], threshold: 0 }, payouts, ...options } = {}) {
    return mutate(options, (ctx, chain, nowSeconds) => {
        if (ctx.signer === chain.maker) refuse('The maker cannot take its own offer');
        const counterparty = chain.side === 'Buy' ? chain.seller : chain.buyer;
        if (chain.status !== 'Open') {
            if (counterparty === ctx.signer && ['Committed', 'Settled'].includes(chain.status)) return null;
            refuse(`The offer is ${chain.status}; it can no longer be taken`);
        }
        beforeDeadline(chain, nowSeconds, 'taken');
        const members = lens?.members || [], threshold = lens?.threshold ?? 0;
        if (chain.side === 'Sell' && !members.length) refuse('A buyer names its lens: the lens members who must confirm the seller holds the asset');
        const schedule = chain.side === 'Buy' ? (payouts || [{ recipient: ctx.signer, amount: String(chain.price) }]) : [];
        if (chain.side === 'Sell' && payouts?.length) refuse('A sale’s payout schedule is fixed by the seller');
        return client.buildCommitIxs({ offer: ctx.address, counterparty: ctx.signer, currency: chain.currency, side: chain.side.toLowerCase(), payouts: schedule, lens: members, lensThreshold: threshold });
    });
}

/**
 * A lens member of the offer confirms, with a PropertyOfferConfirmation-v1 attestation and the
 * program's confirm in one transaction (after any credential/schema setup), and executes when its
 * confirmation completes both lenses. Role 0 (the buyer's lens: the seller holds the asset) needs
 * `holding`, the address of the statement through which the seller holds it (the member's
 * first-holder statement, or the settled offer the seller bought through); the confirmation lands at
 * an address fixed by asset and holding, so the member cannot confirm a second sale of that holding.
 * Role 1 (the seller's lens: the buyer qualifies). `role` picks one when the member sits in both.
 */
export function confirmOffer({ role, holding, ...options } = {}) {
    return mutate(options, async (ctx, chain, nowSeconds) => {
        if (chain.status !== 'Committed') {
            if (chain.status === 'Settled' && [chain.buyerLens, chain.sellerLens].some(lens => lens.confirmed.includes(ctx.signer))) return null;
            refuse(`The offer is ${chain.status}; lens members confirm a committed offer`);
        }
        beforeDeadline(chain, nowSeconds, 'confirmed');
        const roles = [[0, chain.buyerLens], [1, chain.sellerLens]].filter(([r, lens]) => lens.members.includes(ctx.signer) && (role === undefined || role === r));
        if (!roles.length) refuse(`${ctx.signer} is not a lens member of this offer${role === undefined ? '' : ` in role ${role}`}`);
        const open = roles.find(([, lens]) => !lens.confirmed.includes(ctx.signer));
        if (!open) return null;
        const [chosen, lens] = open;
        const assetHash = Offer.assetHash(ctx.row.content.asset);
        if (chosen === 0 && (typeof holding !== 'string' || !holding)) refuse('Confirming that the seller holds the asset needs holding: the statement address through which the seller holds it');
        const statementHolding = chosen === 0 ? holding : '';
        const nonce = client.decisionNonce({ role: chosen, assetHash, holding: statementHolding, offer: ctx.address });
        const issued = Statements.buildCreateAttestationIx({ payer: ctx.signer, authority: ctx.signer, kind: 'confirmation', nonce,
            payload: client.encodeDecisionPayload({ cid: chain.cid, offer: ctx.address, termsHash: chain.termsHash, payoutsHash: chain.payoutsHash, buyer: chain.buyer, seller: chain.seller,
                role: chosen, assetHash, holding: statementHolding, observedAt: nowSeconds }),
            expiry: nowSeconds + Statements.constants.STATEMENT_EXPIRY_SECONDS });
        const existing = await ctx.connection.getAccountInfo(new web3.PublicKey(issued.attestation), 'confirmed');
        if (existing) {
            const prior = client.readDecisionAttestation(new Uint8Array(existing.data), issued.attestation);
            if (prior.fields.offer !== ctx.address) refuse(`You have confirmed another sale of this holding (offer ${prior.fields.offer}); withdraw that confirmation first`);
        }
        const setup = await Statements.setupIxs(ctx.connection, { payer: ctx.signer, authority: ctx.signer, kinds: ['confirmation'] });
        const other = chosen === 0 ? chain.sellerLens : chain.buyerLens;
        const completes = lens.confirmed.length + 1 >= lens.threshold && other.met && chain.escrow === chain.price;
        return [...setup, ...(existing ? [] : [issued.instruction]), client.buildConfirmIx({ offer: ctx.address, attestation: issued.attestation, credential: issued.credential }),
            ...(completes ? executeIxs(ctx, chain) : [])];
    });
}

/** Pays the escrow to the schedule once both lenses are met (permissionless; the signer pays fees and any token accounts). */
export function executeOffer(options = {}) {
    return mutate(options, (ctx, chain, nowSeconds) => {
        if (chain.status === 'Settled') return null;
        if (chain.status !== 'Committed') refuse(`The offer is ${chain.status}, not Committed`);
        if (!chain.buyerLens.met || !chain.sellerLens.met) refuse('The offer still waits for its lens members’ confirmations');
        if (chain.escrow !== chain.price) refuse(`The escrow holds ${chain.escrow} of ${chain.price}`);
        beforeDeadline(chain, nowSeconds, 'executed');
        return executeIxs(ctx, chain);
    });
}

/** The maker withdraws its open offer (a buyer's escrow returns); a cancelled offer is a replay. */
export function cancelOffer(options = {}) {
    return mutate(options, (ctx, chain) => {
        if (ctx.signer !== chain.maker) refuse('Only the maker can cancel this offer');
        if (chain.status === 'Cancelled') return null;
        if (chain.status !== 'Open') refuse(`The offer is ${chain.status}; only an open offer can be cancelled`);
        return [client.buildCancelIx({ offer: ctx.address, maker: ctx.signer, currency: chain.currency })];
    });
}

/** After the deadline, ends an open or committed offer and refunds any escrow to the buyer (permissionless). */
export function expireOffer(options = {}) {
    return mutate(options, (ctx, chain, nowSeconds) => {
        if (chain.status === 'Expired') return null;
        if (chain.status !== 'Open' && chain.status !== 'Committed') refuse(`The offer is ${chain.status}; it cannot expire`);
        if (BigInt(nowSeconds) <= chain.deadline) refuse(`The offer deadline ${new Date(Number(chain.deadline) * 1000).toISOString()} has not passed`);
        return [client.buildExpireIx({ offer: ctx.address, currency: chain.currency, buyer: chain.buyer || chain.maker })];
    });
}

/**
 * This wallet, as a lens member, states who first holds an asset (PropertyHolding-v1, at the one
 * address its key and the asset fix). An existing statement naming the same holder is a replay;
 * one naming another holder is refused (withdraw it first).
 */
export async function stateHolding({ asset, city, holder, basis, evidence = '', nowSeconds, sendAndConfirm = web3.sendAndConfirmTransaction, ...options } = {}) {
    const ctx = await network(options);
    const normalized = Offer.normalizeAsset(asset, city ?? assetCity(asset));
    const assetHash = Offer.assetHash(normalized);
    const address = Statements.holdingAddress(ctx.signer, assetHash).toBase58();
    const existing = await ctx.connection.getAccountInfo(new web3.PublicKey(address), 'confirmed');
    if (existing) {
        const stated = Statements.readHolding(new Uint8Array(existing.data));
        if (stated?.fields.holder === holder) return { signature: null, replayed: true, attestation: address, assetHash };
        refuse(`You have already stated that ${stated?.fields.holder ?? 'someone else'} first holds this; withdraw that statement first`);
    }
    const observedAt = nowSeconds ?? await chainNow(ctx.connection);
    const issued = Statements.buildHoldingIx({ payer: ctx.signer, authority: ctx.signer, assetHash, asset: Offer.assetKey(normalized), holder, basis, evidence, observedAt });
    const setup = await Statements.setupIxs(ctx.connection, { payer: ctx.signer, authority: ctx.signer, kinds: ['holding'] });
    const signature = await send(ctx, [...setup, issued.instruction], sendAndConfirm);
    return { signature, replayed: false, attestation: issued.attestation, assetHash };
}
// A flat's building address names its city; a plot's caller passes `city`.
function assetCity(asset) {
    if (asset?.kind === 'flat') return String(asset.xrayBuilding || '').split('::')[0];
    throw new Error('city is required to state the holder of a plot');
}

/**
 * The index write the browser makes after each confirmed step: POST /property-offers/:cid/onchain
 * with the reference. The API takes writes only from its own sites, so the configured app origin is sent.
 */
export function createOnchainRecorder({ apiBase, appOrigin, fetchImpl = globalThis.fetch } = {}) {
    if (!apiBase || !appOrigin) throw new Error('apiBase and appOrigin are required: the index takes writes only from its own sites');
    const base = String(apiBase).replace(/\/+$/, ''), origin = new URL(appOrigin).origin;
    return async (ref, cid) => {
        const response = await fetchImpl(`${base}/property-offers/${encodeURIComponent(cid)}/onchain`, {
            method: 'POST', signal: AbortSignal.timeout(30000),
            headers: { Accept: 'application/json', 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(ref)
        });
        const row = await response.json();
        if (!response.ok) throw Object.assign(new Error(row.error || `HTTP ${response.status}`), { status: response.status, code: row.code });
        if (row.cid !== cid) throw new Error('The index answered for another offer.');
        return row;
    };
}
