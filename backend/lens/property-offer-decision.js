// Pure, fail-closed planner for PropertyOfferDecision-v2.  It never trusts caller hashes,
// qualification flags, parcel lists, or an account status supplied by the browser.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { PublicKey } from '@solana/web3.js';
import { canonicalBytes, cidOf } from '../cid.js';
import { LensError } from './errors.js';
import { verifyWalletSignature } from './identity/devnet-registry.js';
import { expectedApartmentAnchor } from '../property-offers/onchain.js';

const require = createRequire(import.meta.url);
const Offer = require('../../frontend/js/property-offer-record.js');
export const { sellerConsentMessage } = require('../../frontend/js/property-offer-consent.js');
const key = value => { try { return new PublicKey(value).toBase58() === value; } catch { return false; } };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const parcelUid = Offer.parcelUid;
const payoutHash = payouts => hash(Buffer.concat(payouts.map(row => {
    const amount = Buffer.alloc(8); amount.writeBigUInt64LE(BigInt(row.lamports));
    return Buffer.concat([new PublicKey(row.recipient).toBuffer(), amount]);
})));

/**
 * @param {{ offer: object, account: object, candidate: object, ownerSets: (refs: object[]) => Promise<Map<string, object[]>>, nowSeconds: number }} input
 * `offer` and `account` must be read by the lens from trusted index/chain adapters, never req.body.
 */
export async function planPropertyOfferDecision({ offer, account, candidate, ownerSets, nowSeconds, ownershipHash }) {
    const content = offer?.content;
    const invalid = (code, message) => { throw new LensError(422, code, message); };
    if (!offer?.cid || cidOf(canonicalBytes(content)) !== offer.cid || Offer.validate(content)) invalid('invalid_offer', 'Indexed property-offer content is not canonical.');
    if (!account || account.cid !== offer.cid || String(account.status).toLowerCase() !== 'open' || !key(account.address) || !key(account.maker)) invalid('offer_not_open', 'The trusted chain account is not this open offer.');
    if (account.maker !== content.proposer || account.lens !== content.lens || String(account.side).toLowerCase() !== content.direction
        || String(account.priceLamports) !== content.priceLamports) invalid('account_terms_mismatch', 'The chain account differs from immutable offer roles or price.');
    const deadline = Number(account.deadline);
    if (!Number.isFinite(deadline) || deadline <= nowSeconds || Math.floor(Date.parse(content.expiresAt) / 1000) !== deadline) invalid('deadline_mismatch', 'The chain account deadline differs from the immutable offer.');
    const termsHash = hash(canonicalBytes(content));
    if (account.termsHash !== termsHash) invalid('terms_mismatch', 'The chain account does not commit to the indexed offer terms.');
    const buyer = candidate?.buyer, seller = candidate?.seller;
    if (!key(buyer) || !key(seller) || buyer === seller) invalid('invalid_counterparty', 'Choose distinct buyer and seller wallets.');
    const payouts = content.direction === 'sell' ? content.payouts : candidate?.payouts;
    if (!Array.isArray(payouts) || !payouts.length || Offer.validate({ ...content, direction: 'sell', buyer: null, seller: content.proposer, payouts })) invalid('invalid_payouts', 'The final payout schedule is invalid.');
    const normalized = Offer.published({ ...content, direction: 'sell', buyer: null, seller: content.proposer, payouts });
    const schedule = normalized.payouts;
    const scheduleHash = payoutHash(schedule);
    const expectedBuyer = content.direction === 'buy' ? content.buyer : buyer;
    const expectedSeller = content.direction === 'sell' ? content.seller : seller;
    if (buyer !== expectedBuyer || seller !== expectedSeller) invalid('role_mismatch', 'The candidate counterparties do not match offer direction.');
    const terms = { cid: offer.cid, offer: account.address, termsHash, payoutsHash: scheduleHash, buyer, seller };
    if (content.apartment) {
        if (content.direction === 'sell' && account.payoutsHash !== scheduleHash) invalid('payouts_mismatch', 'The committed sale schedule differs from the chain account.');
        if (account.apartmentAnchor !== expectedApartmentAnchor(content)) invalid('apartment_anchor_mismatch', 'The offer refers to a different apartment address.');
        if (candidate.payouts && hash(canonicalBytes(candidate.payouts)) !== hash(canonicalBytes(schedule))) invalid('payouts_mismatch', 'The proposed schedule differs from the offer terms.');
        // These are the terms the chosen lens is asked to qualify. A wallet request cannot grant qualification.
        return terms;
    }
    if (typeof ownershipHash !== 'string' || !/^[a-f0-9]{64}$/.test(ownershipHash) || candidate?.ownershipHash !== ownershipHash) {
        invalid('ownership_changed', 'The signatures must name the current ownership evidence.');
    }
    const sets = await ownerSets(content.parcels);
    let observedAt = 0;
    const observedOwners = new Set();
    for (const parcel of content.parcels) {
        const rows = sets.get(parcelUid(parcel)) || [];
        if (!rows.length) invalid('ownership_missing', `No ownership evidence exists for ${parcelUid(parcel)}.`);
        if (rows.length > Offer.MAX_PAYOUTS) invalid('too_many_owners', 'The parcel exceeds the supported payout-recipient limit.');
        const distinctOwners = new Set(rows.map(row => row.owner));
        if (distinctOwners.size !== rows.length || rows.some(row => row.ownerCount !== rows.length)) invalid('ownership_incomplete', 'The registry does not contain the complete declared owner set.');
        for (const row of rows) { if (!key(row.owner) || !Number.isSafeInteger(row.establishedAt) || row.establishedAt < 0 || row.establishedAt > nowSeconds) invalid('ownership_time_invalid', `Ownership evidence for ${parcelUid(parcel)} is incomplete.`); observedOwners.add(row.owner); observedAt = Math.max(observedAt, row.establishedAt); }
    }
    const recipients = new Set(schedule.map(row => row.recipient));
    if (recipients.size !== observedOwners.size || [...observedOwners].some(owner => !recipients.has(owner))) invalid('payout_ownership_mismatch', 'Every observed owner must be an exact payout recipient.');
    if (!observedOwners.has(seller)) invalid('seller_not_owner', 'The candidate seller is not in current ownership evidence.');
    if (!Array.isArray(candidate?.consents) || candidate.consents.length > Offer.MAX_PAYOUTS) invalid('invalid_consents', 'Supply the bounded seller consent list.');
    const consentByOwner = new Map((candidate?.consents || []).map(row => [row?.owner, row]));
    if (consentByOwner.size !== candidate.consents.length) invalid('duplicate_consents', 'A seller consent is listed more than once.');
    if (consentByOwner.size !== observedOwners.size || [...observedOwners].some(owner => !consentByOwner.has(owner))) invalid('missing_seller_consent', 'Every observed owner must provide one consent.');
    const message = owner => sellerConsentMessage({ cid: offer.cid, offer: account.address, termsHash, payoutsHash: scheduleHash, ownershipHash, buyer, seller: owner });
    for (const owner of observedOwners) if (!verifyWalletSignature({ owner, message: message(owner), signature: consentByOwner.get(owner).signature })) invalid('bad_seller_consent', `Seller consent is invalid for ${owner}.`);
    if (content.direction === 'sell' && account.payoutsHash !== scheduleHash) invalid('payouts_mismatch', 'The committed sale schedule differs from the chain account.');
    return { ...terms, ownershipHash, counterpartyQualified: 1, sourceObservedAt: observedAt };
}
