// Standalone purchase and sale offers share the same price, parties, consent and settlement
// rules for a parcel bundle or one addressable apartment.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PropertyOfferRecord = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const PUBLISHED_SCHEMA = 'property-offer/v1';
    const MAX_PARCELS = 200;
    const MAX_PAYOUTS = 16;
    const MAX_TEXT = { title: 500, city: 100 };
    const base58 = () => root.LensCore || (typeof require === 'function' ? require('./lens-core.js') : null);
    const cidApi = () => root.Cid || (typeof require === 'function' ? require('./cid.js') : null);
    const unitLinks = () => root.BuildingUnitLinks || (typeof require === 'function' && require('./building-unit-links.js'));
    const sha256 = () => root.__consentSha256 || (typeof require === 'function' && require('../vendor/noble-hashes-1.8.0/sha256.js'));
    const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
    const text = (value, max = 3507) => typeof value === 'string' && value.trim() && value.trim().length <= max ? value.trim() : null;
    const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
    const key = value => !!base58()?.isBase58Pubkey?.(value);
    const lamports = value => typeof value === 'string' && /^(?:[1-9]\d*)$/.test(value) && BigInt(value) <= 18446744073709551615n;
    const parcelKey = parcel => JSON.stringify([parcel.sourceId, parcel.id, parcel.snapshotId || null]);
    const fail = (code, message) => ({ code, message });

    // The anchor identifies the unit even when the asking price, camera or parties change.
    function apartmentKey(ref) {
        if (!unitLinks().apartmentLocator(ref?.xrayBuilding) || !unitLinks().apartmentUnitLocator(ref?.unit)) {
            throw new Error('An apartment requires an exact X-ray building and unit address.');
        }
        return JSON.stringify(['apartment/v1', ref.xrayBuilding, ref.unit]);
    }
    const apartmentHash = ref => sha256().sha256Hex(apartmentKey(ref));
    function normalizeApartment(ref) {
        if (!object(ref) || Object.keys(ref).some(key => !['xrayBuilding', 'unit', 'at', 'access'].includes(key))) {
            throw new Error('An apartment offer requires one X-ray address and its map location.');
        }
        apartmentKey(ref);
        if (!unitLinks().apartmentLocation(ref.at)) throw new Error('The apartment requires a valid map location.');
        if (ref.access != null && (!['auto', 'point', 'corridor'].includes(ref.access)
            || (ref.access !== 'auto' && unitLinks().apartmentUnitLocator(ref.unit).length !== 3))) {
            throw new Error('The access layout must match the estimated apartment link.');
        }
        return { xrayBuilding: ref.xrayBuilding, unit: ref.unit, at: ref.at,
            ...(ref.access && ref.access !== 'auto' ? { access: ref.access } : {}) };
    }

    function offerSubject(raw, city) {
        if (raw.apartment != null) {
            if (raw.parcels != null) throw new Error('Choose either a whole apartment or a parcel bundle.');
            const apartment = normalizeApartment(raw.apartment);
            const [sourceCity] = unitLinks().apartmentLocator(apartment.xrayBuilding);
            if (sourceCity !== 'design' && sourceCity !== city) throw new Error('Use the city from this apartment’s X-ray address.');
            return { apartment };
        }
        const parcels = Array.isArray(raw.parcels) ? raw.parcels.map(normalizeParcel).sort((a, b) => parcelKey(a).localeCompare(parcelKey(b))) : null;
        if (!parcels?.length || parcels.length > MAX_PARCELS) throw new Error(`An offer needs one apartment or from 1 to ${MAX_PARCELS} parcels.`);
        if (new Set(parcels.map(parcel => JSON.stringify([parcel.sourceId, parcel.id]))).size !== parcels.length) throw new Error('A parcel is listed more than once.');
        return { parcels };
    }

    function normalizeParcel(value) {
        if (!object(value)) throw new Error('Every parcel needs a source-qualified reference.');
        const sourceId = text(value.sourceId), id = text(value.id);
        const snapshotId = value.snapshotId == null ? null : text(value.snapshotId);
        if (!sourceId || !id || (value.snapshotId != null && !snapshotId)) throw new Error('Every parcel needs sourceId and id; snapshotId is optional text.');
        return snapshotId ? { sourceId, id, snapshotId } : { sourceId, id };
    }

    function normalizePayout(value) {
        if (!object(value) || !key(value.recipient) || !lamports(value.lamports)) throw new Error('Every payout needs a recipient and positive whole lamports.');
        return { recipient: value.recipient, lamports: value.lamports };
    }

    function normalize(raw, { now = Date.now() } = {}) {
        if (!object(raw)) throw new Error('A property offer must be an object.');
        if (raw.schema !== PUBLISHED_SCHEMA) throw new Error('Expected property-offer/v1 schema.');
        if (raw.schema != null && raw.schema !== PUBLISHED_SCHEMA) throw new Error(`Expected ${PUBLISHED_SCHEMA}.`);
        const direction = raw.direction;
        if (direction !== 'buy' && direction !== 'sell') throw new Error('Offer direction must be buy or sell.');
        const proposer = text(raw.proposer);
        const buyer = raw.buyer == null ? null : text(raw.buyer);
        const seller = raw.seller == null ? null : text(raw.seller);
        const lens = text(raw.lens);
        if (!key(proposer) || !key(lens) || (buyer && !key(buyer)) || (seller && !key(seller))) throw new Error('Proposer, lens and named counterparties must be Solana public keys.');
        if ((direction === 'buy' && (buyer !== proposer || seller !== null)) || (direction === 'sell' && (seller !== proposer || buyer !== null))) {
            throw new Error('A buy offer has its proposer as buyer and an open seller; a sell offer has its proposer as seller and an open buyer.');
        }
        const createdAt = raw.createdAt == null ? new Date(now).toISOString() : raw.createdAt;
        if (!instant(createdAt) || !instant(raw.expiresAt) || Date.parse(raw.expiresAt) <= Date.parse(createdAt)) throw new Error('createdAt and expiresAt must be ISO instants, with expiry after creation.');
        if (!lamports(raw.priceLamports)) throw new Error('priceLamports must be a positive canonical u64 decimal string.');
        const payouts = raw.payouts == null ? null : Array.isArray(raw.payouts) ? raw.payouts.map(normalizePayout).sort((a, b) => a.recipient.localeCompare(b.recipient)) : undefined;
        if (direction === 'buy' && payouts !== null) throw new Error('A buy offer has no payout schedule until its owners accept it.');
        if (direction === 'sell') {
            if (!payouts?.length || payouts.length > MAX_PAYOUTS) throw new Error(`A sell offer needs from 1 to ${MAX_PAYOUTS} payout recipients.`);
            if (new Set(payouts.map(row => row.recipient)).size !== payouts.length) throw new Error('A payout recipient is listed more than once.');
            if (payouts.reduce((sum, row) => sum + BigInt(row.lamports), 0n) !== BigInt(raw.priceLamports)) throw new Error('Sell payouts must total priceLamports exactly.');
        }
        const title = raw.title == null ? null : text(raw.title, MAX_TEXT.title);
        const city = text(raw.city, MAX_TEXT.city);
        if (!city || (raw.title != null && !title)) throw new Error('city is required and title, when supplied, is non-empty text.');
        return { id: raw.id == null ? null : text(raw.id), schema: PUBLISHED_SCHEMA, ...(title ? { title } : {}), city, createdAt, expiresAt: raw.expiresAt,
            direction, proposer, buyer, seller, lens, ...offerSubject(raw, city), priceLamports: raw.priceLamports, ...(payouts ? { payouts } : {}) };
    }

    function validate(raw, options) { try { normalize(raw, options); return null; } catch (error) { return fail('invalid-property-offer', error.message); } }
    function published(raw, options) { const { id: _id, ...content } = normalize(raw, options); return content; }
    function cid(raw, options) { return cidApi().cidOfObject(published(raw, options)); }
    function newId() { const bytes = new Uint8Array(16); root.crypto.getRandomValues(bytes); return `po-${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`; }
    return { PUBLISHED_SCHEMA, MAX_PARCELS, MAX_PAYOUTS, parcelUid: parcelKey,
        apartmentKey, apartmentHash, normalizeApartment, normalize, validate, published, cid, newId };
});
