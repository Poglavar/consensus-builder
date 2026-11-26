// Node signer adapter for standalone property offers (programs/property_offer): an MCP agent holding its
// own Solana keypair creates, accepts, funds, releases, cancels and expires a published offer the way a
// person does in the browser's offer panel (frontend/js/solana/property-offer-bridge.js), on the same
// codecs and wallet messages. Every step reads the chain account first and checks it against the
// published terms with the index's own check (property-offers/onchain.js), refuses before signing what
// the program or the lens would refuse, signs nothing on a replay, and then records the chain reference
// in the index through the injected `recordOnchain(ref, cid)` (createOnchainRecorder is the HTTP one).
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalBytes } from '../cid.js';
import { client, expectedApartmentAnchor, readOfferAnchor, validateOfferAccount } from '../property-offers/onchain.js';
import { prepareAcceptance, verifyConsent } from '../property-offers/acceptance.js';
import { signMessageBytes } from './lens-ownership-client.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const anchors = require('../../frontend/js/solana/parcel-client.js').configure({ web3 });
const Offer = require('../../frontend/js/property-offer-record.js');
const Consent = require('../../frontend/js/property-offer-consent.js');
const LensCore = require('../../frontend/js/lens-core.js');

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const { DEFAULT_PUBKEY, PROPERTY_OFFER_PROGRAM_ID, SAS_PROGRAM_ID } = client.constants;
const termsHashOf = content => createHash('sha256').update(canonicalBytes(content)).digest('hex');
const deadlineOf = content => Math.floor(Date.parse(content.expiresAt) / 1000);
const nowDefault = () => Math.floor(Date.now() / 1000);
const refuse = message => { throw Object.assign(new Error(`${message}; nothing signed.`), { code: 'refused' }); };

function serviceBase(lensServiceUrl) {
    if (!lensServiceUrl) throw new Error('lensServiceUrl (the service of the lens member the offer names) is required');
    return String(lensServiceUrl).replace(/\/+$/, '');
}

async function lensPost(fetchImpl, url, body, timeoutMs) {
    if (typeof fetchImpl !== 'function') throw new Error('a fetch implementation is required');
    const response = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs), body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.message || result.error || `Lens HTTP ${response.status}`), { status: response.status, code: result.error });
    return result;
}

/** The bridge's context(): the network, the program, the published CID and the offer address. */
async function context({ connection, keypair, row, cluster, recordOnchain }) {
    if (!connection?.getAccountInfo) throw new Error('a solana connection is required');
    if (!keypair?.publicKey) throw new Error('keypair is required');
    if (typeof recordOnchain !== 'function') throw new Error('recordOnchain (ref, cid) is required to index the confirmed step');
    if (!row?.cid || !row.content || Offer.cid(row.content) !== row.cid) throw new Error('The offer content does not match its published CID.');
    const network = cluster || row.onchain?.cluster || 'devnet';
    if (!['devnet', 'localnet'].includes(network)) throw new Error('Property offers currently support Solana devnet and localnet.');
    if (row.onchain?.cluster && row.onchain.cluster !== network) throw new Error(`The offer is indexed on ${row.onchain.cluster}, not ${network}.`);
    if (network === 'devnet' && await connection.getGenesisHash() !== DEVNET_GENESIS) throw new Error('The RPC network does not match Solana devnet.');
    const program = await connection.getAccountInfo(new web3.PublicKey(PROPERTY_OFFER_PROGRAM_ID));
    if (!program?.executable) throw Object.assign(new Error('The property offer program is not deployed on this Solana network yet.'), { code: 'program-not-deployed' });
    const address = client.getOfferPda(row.cid, row.content.proposer)[0].toBase58();
    if (row.onchain?.account && row.onchain.account !== address) throw new Error('The chain address does not match the published offer.');
    return { connection, keypair, row, recordOnchain, cluster: network, address, signer: keypair.publicKey.toBase58() };
}

/** The bridge's readWith(): null before create; otherwise the account, proven to carry the published terms. */
async function readChain(ctx, { allowMissingAnchor = false } = {}) {
    const { connection, row, address } = ctx;
    const account = await client.fetchPropertyOffer(connection, { address });
    if (!account) return null;
    if (allowMissingAnchor && row.content.apartment && !await anchors.readApartmentAnchor(connection, Offer.apartmentHash(row.content.apartment))) {
        // The anchor is minted next; every other term must already match the published offer.
        validateOfferAccount(row, { ...account, apartmentAnchor: expectedApartmentAnchor(row.content) });
        return { ...account, apartmentAnchor: null };
    }
    return validateOfferAccount(row, await readOfferAnchor(connection, row, account));
}

async function send(ctx, instructions, sendAndConfirm) {
    const transaction = new web3.Transaction().add(...instructions);
    transaction.feePayer = ctx.keypair.publicKey;
    return sendAndConfirm(ctx.connection, transaction, [ctx.keypair], { commitment: 'confirmed' });
}

/** The bridge's persist(): read back, then index the reference (also on a replay, which re-syncs the index). */
async function persist(ctx, signature) {
    const chain = await readChain(ctx);
    const ref = { chain: 'solana', cluster: ctx.cluster, account: ctx.address, signature: signature ?? ctx.row.onchain?.signature ?? null, status: chain?.status?.toLowerCase() };
    if (chain?.apartmentAnchor) ref.apartmentAnchor = chain.apartmentAnchor;
    let indexed;
    try { indexed = await ctx.recordOnchain(ref, ctx.row.cid); }
    catch (cause) {
        throw Object.assign(new Error('The Solana step is on chain, but the index could not record it. Repeat the same step: it signs nothing again and retries the record.'),
            { cause, signature, ref });
    }
    return { signature, replayed: signature === null, account: ctx.address, status: ref.status, onchain: indexed?.onchain ?? null };
}

/** Read, plan (null = replay; throw = refuse), send, index: the bridge's mutate(). */
async function mutate({ sendAndConfirm = web3.sendAndConfirmTransaction, ...options }, plan) {
    const ctx = await context(options);
    const chain = await readChain(ctx);
    if (!chain) refuse('Create this offer on Solana first');
    const instructions = plan(ctx, chain);
    return persist(ctx, instructions ? await send(ctx, instructions, sendAndConfirm) : null);
}

const open = (chain, nowSeconds, what) => { if (BigInt(nowSeconds) > chain.deadline) refuse(`The offer deadline has passed; it can no longer be ${what}`); };

/** The named lens's credential and PropertyOfferDecision schema exist on this network (the bridge's preflight). */
async function requireDecisionSchema(ctx, credential, schemaAddress = null) {
    const schema = client.getDecisionSchemaPda(credential)[0];
    if (schemaAddress && schema.toBase58() !== schemaAddress) refuse('The lens offer schema address differs from its credential');
    const [credentialInfo, schemaInfo] = await Promise.all([
        ctx.connection.getAccountInfo(new web3.PublicKey(credential), 'confirmed'), ctx.connection.getAccountInfo(schema, 'confirmed')
    ]);
    client.validateDecisionSchema({ credential, authority: ctx.row.content.lens, credentialInfo, schemaInfo });
}

/** The program's own decision checks (sas_attestation::property::qualification), run before the accept is signed. */
async function requireDecision(ctx, prepared, decision, { nowSeconds, attempts, pauseMs }) {
    if (!decision?.address || !decision?.credential) refuse('The lens answered without a decision attestation');
    await requireDecisionSchema(ctx, decision.credential);
    // The lens member's own transaction created the attestation; this RPC may not show it yet.
    let info = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        info = await ctx.connection.getAccountInfo(new web3.PublicKey(decision.address), 'confirmed');
        if (info || attempt === attempts) break;
        await delay(pauseMs * attempt);
    }
    if (!info || !new web3.PublicKey(info.owner).equals(new web3.PublicKey(SAS_PROGRAM_ID))) refuse(`The lens decision ${decision.address} is not a SAS attestation on this network`);
    const attestation = client.readDecisionAttestation(new Uint8Array(info.data), decision.address);
    if (attestation.credential !== decision.credential || attestation.signer !== ctx.row.content.lens
        || attestation.schema !== client.getDecisionSchemaPda(decision.credential)[0].toBase58()) refuse('The decision attestation belongs to another lens, credential or schema');
    const expected = { cid: ctx.row.cid, offer: ctx.address, termsHash: prepared.termsHash, payoutsHash: prepared.payoutsHash, buyer: prepared.buyer, seller: prepared.seller };
    const differs = Object.keys(expected).filter(name => attestation.fields[name] !== expected[name]);
    if (differs.length) refuse(`The lens decision attests other terms (${differs.join(', ')})`);
    if (attestation.fields.counterpartyQualified !== 1) refuse('The lens has not qualified this counterparty');
    if (attestation.expiry <= BigInt(nowSeconds)) refuse('The lens decision has expired');
}

/**
 * The proposer creates its published offer on Solana; for an apartment offer the same transaction mints
 * the apartment's ownerless anchor (init_if_needed). The named lens must first answer its pre-mint check
 * and hold its decision schema on this network, as in the browser. An existing account is a replay.
 */
export async function createOfferOnChain({ lensServiceUrl, fetchImpl = globalThis.fetch, nowSeconds = nowDefault(),
    sendAndConfirm = web3.sendAndConfirmTransaction, ...options } = {}) {
    const ctx = await context(options), content = ctx.row.content;
    if (ctx.signer !== content.proposer) refuse('Only the proposer can create this offer on Solana');
    const prior = await readChain(ctx, { allowMissingAnchor: true });
    if (prior && (!content.apartment || prior.apartmentAnchor)) return persist(ctx, null);
    if (!prior) {
        if (deadlineOf(content) <= nowSeconds) refuse(`The offer expired at ${content.expiresAt}`);
        const check = await lensPost(fetchImpl, `${serviceBase(lensServiceUrl)}/lens/property-offers/check`, { content }, 30000);
        if (check.key !== content.lens || !check.credential || !check.schema) refuse('The lens returned another authority or no offer schema');
        await requireDecisionSchema(ctx, check.credential, check.schema);
    }
    const instructions = [];
    if (content.apartment) instructions.push(anchors.buildMintApartmentIx({ payer: ctx.signer, identityHash: Offer.apartmentHash(content.apartment) }).instruction);
    if (!prior) instructions.push(client.buildCreateIx({ maker: ctx.signer, cid: ctx.row.cid, lens: content.lens, side: content.direction,
        termsHash: termsHashOf(content), priceLamports: content.priceLamports, deadline: deadlineOf(content), payouts: content.payouts || [] }).instruction);
    return persist(ctx, await send(ctx, instructions, sendAndConfirm));
}

/**
 * The accepting counterparty (the buyer of a sell offer, the seller of a buy offer) signs the decision
 * request, asks the named lens for its decision and records it on chain. `candidate` is the acceptance
 * the MCP prepare tool returns or a shared acceptance's; it is re-derived from the published offer.
 * A parcel offer needs every payout recipient's seller consent; an apartment offer relies on the lens's
 * qualification of this counterparty. An offer already accepted by these parties is a replay.
 */
export async function acceptOffer({ candidate, lensServiceUrl, fetchImpl = globalThis.fetch, nowSeconds = nowDefault(),
    attestationReadAttempts = 4, attestationPauseMs = 3000, sendAndConfirm = web3.sendAndConfirmTransaction, ...options } = {}) {
    if (!(options.keypair?.secretKey instanceof Uint8Array)) throw new Error('keypair with its secretKey is required to sign the decision request');
    const ctx = await context(options), content = ctx.row.content;
    const { candidate: terms } = prepareAcceptance(ctx.row, candidate || {});
    const consents = content.apartment ? [] : (candidate?.consents || []).map(row => ({ owner: row?.owner, signature: row?.signature }));
    const prepared = { ...terms, consents };
    const requester = content.direction === 'buy' ? prepared.seller : prepared.buyer;
    if (ctx.signer !== requester) refuse(`Only the accepting counterparty ${requester} can accept this offer, not ${ctx.signer}`);
    if (!content.apartment) {
        if (new Set(consents.map(row => row.owner)).size !== consents.length) refuse('A seller consent is listed more than once');
        if (prepared.payouts.some(row => !consents.some(consent => consent.owner === row.recipient))) refuse('Every seller must sign the exact payment schedule before acceptance');
        for (const consent of consents) verifyConsent(prepared, consent);
    }
    const chain = await readChain(ctx);
    if (!chain) refuse('Create this offer on Solana first');
    if (chain.status !== 'Open') {
        if (['Accepted', 'Settled'].includes(chain.status) && chain.buyer === prepared.buyer && chain.seller === prepared.seller) return persist(ctx, null);
        refuse(`The offer is ${chain.status}; it can no longer be accepted`);
    }
    open(chain, nowSeconds, 'accepted');
    const signature = LensCore.base58Encode(new Uint8Array(signMessageBytes({ secretKey: ctx.keypair.secretKey, message: Consent.requestMessage(prepared) })));
    const decision = await lensPost(fetchImpl, `${serviceBase(lensServiceUrl)}/lens/property-offers/${encodeURIComponent(ctx.row.cid)}/decision`,
        { ...prepared, requester, signature }, 60000);
    await requireDecision(ctx, prepared, decision, { nowSeconds, attempts: attestationReadAttempts, pauseMs: attestationPauseMs });
    return persist(ctx, await send(ctx, [client.buildAcceptIx({ offer: ctx.address, counterparty: ctx.signer,
        payouts: content.direction === 'buy' ? prepared.payouts : [], attestation: decision.address, credential: decision.credential })], sendAndConfirm));
}

/** The bound buyer deposits exactly the price once; a funded or settled offer is a replay. */
export function fundOffer({ nowSeconds = nowDefault(), ...options } = {}) {
    return mutate(options, (ctx, chain) => {
        if (chain.status === 'Open') refuse('The offer is not accepted yet');
        if (chain.status === 'Cancelled' || chain.status === 'Expired') refuse(`The offer is ${chain.status}; it can no longer be funded`);
        if (chain.buyer !== ctx.signer) refuse(`Only the buyer ${chain.buyer} can fund this offer`);
        if (chain.status === 'Settled' || chain.escrowLamports === chain.priceLamports) return null;
        open(chain, nowSeconds, 'funded');
        return [client.buildFundIx({ offer: ctx.address, buyer: ctx.signer })];
    });
}

/** Pays the funded price to the scheduled recipients in schedule order (permissionless; the signer pays the fee). */
export function releaseOffer({ nowSeconds = nowDefault(), ...options } = {}) {
    return mutate(options, (ctx, chain) => {
        if (chain.status === 'Settled') return null;
        if (chain.status !== 'Accepted') refuse(`The offer is ${chain.status}, not Accepted`);
        if (chain.decisionAttestation === DEFAULT_PUBKEY) refuse('The offer has no recorded lens decision');
        if (chain.escrowLamports !== chain.priceLamports) refuse(`The escrow holds ${chain.escrowLamports} of ${chain.priceLamports} lamports; the buyer must fund it first`);
        open(chain, nowSeconds, 'released');
        return [client.buildExecuteIx({ offer: ctx.address, recipients: chain.payouts.map(payout => payout.recipient) })];
    });
}

/** The proposer withdraws its open offer; a cancelled offer is a replay. */
export function cancelOffer(options = {}) {
    return mutate(options, (ctx, chain) => {
        if (ctx.signer !== chain.maker) refuse('Only the proposer can cancel this offer');
        if (chain.status === 'Cancelled') return null;
        if (chain.status !== 'Open') refuse(`The offer is ${chain.status}; only an open offer can be cancelled`);
        return [client.buildCancelIx({ offer: ctx.address, authority: ctx.signer })];
    });
}

/** After the deadline, closes an open or accepted offer and refunds any escrow to the buyer (permissionless). */
export function expireOffer({ nowSeconds = nowDefault(), ...options } = {}) {
    return mutate(options, (ctx, chain) => {
        if (chain.status === 'Expired') return null;
        if (chain.status !== 'Open' && chain.status !== 'Accepted') refuse(`The offer is ${chain.status}; it cannot expire`);
        if (BigInt(nowSeconds) <= chain.deadline) refuse(`The offer deadline ${new Date(Number(chain.deadline) * 1000).toISOString()} has not passed`);
        return [client.buildExpireIx({ offer: ctx.address, buyer: chain.buyer === DEFAULT_PUBKEY ? chain.maker : chain.buyer })];
    });
}

/**
 * The index write the browser's PropertyOfferSync.recordOnchain makes: POST /property-offers/:cid/onchain
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
