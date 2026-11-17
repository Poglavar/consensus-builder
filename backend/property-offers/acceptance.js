// Canonical shared acceptance terms. A session is one immutable proposal for the open side;
// signatures are merged independently, never by replacing another owner's consent.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { canonicalBytes } from '../cid.js';
import { client } from './onchain.js';
import { verifyWalletSignature } from '../lens/identity/devnet-registry.js';
const require = createRequire(import.meta.url);
const Offer = require('../../frontend/js/property-offer-record.js');
const Consent = require('../../frontend/js/property-offer-consent.js');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const reject = message => { throw Object.assign(new Error(message), { status: 422 }); };
export function prepareAcceptance(row, raw = {}) {
    const c = Offer.published(row.content), cid = Offer.cid(c);
    if (cid !== row.cid) reject('Offer CID mismatch.');
    const buyer = c.direction === 'buy' ? c.proposer : raw.buyer;
    const seller = c.direction === 'sell' ? c.proposer : raw.seller;
    client.getOfferPda(cid, buyer); client.getOfferPda(cid, seller);
    if (buyer === seller) reject('Buyer and seller must differ.');
    const payouts = Offer.published({ ...c, direction: 'sell', buyer: null, seller: c.proposer,
        payouts: c.direction === 'sell' ? c.payouts : raw.payouts }).payouts;
    if (!payouts.some(p => p.recipient === seller)) reject('The seller representative must be a payout recipient.');
    const candidate = { cid, offer: client.getOfferPda(cid, c.proposer)[0].toBase58(),
        termsHash: hash(canonicalBytes(c)), payoutsHash: Buffer.from(client.payoutScheduleHash(payouts)).toString('hex'), buyer, seller, payouts };
    for (const key of ['cid', 'offer', 'termsHash', 'payoutsHash', 'buyer', 'seller']) {
        if (raw[key] != null && raw[key] !== candidate[key]) reject(`Acceptance ${key} differs from the offer.`);
    }
    if (raw.payouts && hash(canonicalBytes(raw.payouts)) !== hash(canonicalBytes(payouts))) reject('Payouts must match the canonical acceptance schedule.');
    return { id: hash(canonicalBytes(candidate)), candidate };
}
export function verifyConsent(candidate, consent) {
    if (!consent || !candidate.payouts.some(p => p.recipient === consent.owner)
        || typeof consent.signature !== 'string' || consent.signature.length > 128
        || !verifyWalletSignature({ owner: consent.owner, signature: consent.signature,
            message: Consent.sellerConsentMessage({ ...candidate, seller: consent.owner }) })) reject('Invalid seller consent for these exact terms.');
    return { owner: consent.owner, signature: consent.signature };
}
export function verifySessionAuthor(id, candidate, { requester, signature } = {}) {
    if (![candidate.buyer, candidate.seller, ...candidate.payouts.map(p => p.recipient)].includes(requester)
        || typeof signature !== 'string' || signature.length > 128
        || !verifyWalletSignature({ owner: requester, signature, message: Consent.sessionMessage({ cid: candidate.cid, id }) })) reject('A party to this acceptance must sign its sharing request.');
}
export function serializeAcceptance(row) {
    const consents = Object.entries(row.consents || {}).map(([owner, signature]) => ({ owner, signature })).sort((a,b) => a.owner.localeCompare(b.owner));
    return { id: row.id, candidate: { ...row.candidate, consents },
        waitingFor: row.candidate.payouts.map(p => p.recipient).filter(owner => !consents.some(c => c.owner === owner)) };
}
export function createAcceptanceStore(pool) {
    return {
        async get(cid, id) { const { rows } = await pool.query('SELECT id,candidate,consents FROM consensus.property_offer_acceptance WHERE offer_cid=$1 AND id=$2', [cid,id]); return rows[0] || null; },
        async create(cid, id, candidate) {
            const db = await pool.connect();
            try {
                await db.query('BEGIN');
                await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`property-offer-acceptance:${cid}`]);
                const existing = await db.query('SELECT id,candidate,consents FROM consensus.property_offer_acceptance WHERE offer_cid=$1 AND id=$2', [cid,id]);
                if (existing.rows[0]) { await db.query('COMMIT'); return existing.rows[0]; }
                const count = await db.query('SELECT count(*)::int AS count FROM consensus.property_offer_acceptance WHERE offer_cid=$1', [cid]);
                if (count.rows[0].count >= 32) reject('This offer already has 32 acceptance proposals.');
                const { rows } = await db.query('INSERT INTO consensus.property_offer_acceptance (offer_cid,id,candidate) VALUES ($1,$2,$3::jsonb) RETURNING id,candidate,consents', [cid,id,JSON.stringify(candidate)]);
                await db.query('COMMIT'); return rows[0];
            } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
        },
        async addConsent(cid,id,{ owner,signature }) {
            const { rows } = await pool.query(`UPDATE consensus.property_offer_acceptance SET consents=consents || jsonb_build_object($3::text,$4::text),updated_at=now()
                WHERE offer_cid=$1 AND id=$2 RETURNING id,candidate,consents`, [cid,id,owner,signature]);
            return rows[0] || null;
        }
    };
}
