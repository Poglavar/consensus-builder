// A purchase or sale offer for one asset: one plot as its parcel source gives it, or one flat by its
// xrayBuilding · storey · flat address (the same fields a developer round's flats carry). The maker names its side's lens; the price is in SOL or devnet
// USDC base units. The CID commits these terms; the program commits their hash.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PropertyOfferRecord = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const PUBLISHED_SCHEMA = 'property-offer/v2';
    const MAX_PAYOUTS = 16;
    const MAX_LENS = 8;
    const CURRENCIES = Object.freeze({ SOL: { decimals: 9 }, USDC: { decimals: 6 } });
    const MAX_TEXT = { title: 500, city: 100, ref: 200 };
    const base58 = () => root.LensCore || (typeof require === 'function' ? require('./lens-core.js') : null);
    const cidApi = () => root.Cid || (typeof require === 'function' ? require('./cid.js') : null);
    const unitLinks = () => root.BuildingUnitLinks || (typeof require === 'function' && require('./building-unit-links.js'));
    const sha256 = () => root.__consentSha256 || (typeof require === 'function' && require('../vendor/noble-hashes-1.8.0/sha256.js'));
    const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
    const text = (value, max = 3507) => typeof value === 'string' && value.trim() && value.trim().length <= max ? value.trim() : null;
    const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
    const key = value => !!base58()?.isBase58Pubkey?.(value);
    const amount = value => typeof value === 'string' && /^(?:[1-9]\d*)$/.test(value) && BigInt(value) <= 18446744073709551615n;
    const fail = (code, message) => ({ code, message });
    const only = (value, keys, message) => { if (!object(value) || Object.keys(value).some(k => !keys.includes(k))) throw new Error(message); };

    // The asset's identity: what lens statements, anchors and the index key on. It ignores price,
    // parties, camera and the map location.
    function assetKey(asset) {
        if (asset?.kind === 'parcel') return JSON.stringify(['parcel/v1', asset.sourceId, asset.id]);
        if (asset?.kind === 'flat') return unitLinks().flatKey(asset.xrayBuilding, asset.unit);
        throw new Error('An offer is for one plot or one flat.');
    }
    const assetHash = asset => sha256().sha256Hex(assetKey(asset));

    function normalizeAsset(raw, city) {
        if (raw?.kind === 'parcel') {
            only(raw, ['kind', 'sourceId', 'id', 'at'], 'A plot needs its parcel source, its id and its map location.');
            const sourceId = text(raw.sourceId, MAX_TEXT.ref), id = text(raw.id, MAX_TEXT.ref);
            if (!sourceId || !id) throw new Error('A plot needs its parcel source and its id.');
            if (!unitLinks().apartmentLocation(raw.at)) throw new Error('The plot needs a valid map location.');
            return { kind: 'parcel', sourceId, id, at: raw.at };
        }
        if (raw?.kind === 'flat') {
            only(raw, ['kind', 'xrayBuilding', 'unit', 'at', 'access'], 'A flat needs its building, its storey::flat address and its map location.');
            assetKey(raw);
            if (!unitLinks().apartmentLocation(raw.at)) throw new Error('The flat needs a valid map location.');
            if (raw.access != null && !['point', 'corridor'].includes(raw.access)) throw new Error('A flat’s layout access is point or corridor.');
            const [sourceCity] = unitLinks().apartmentLocator(raw.xrayBuilding);
            if (sourceCity !== 'design' && sourceCity !== city) throw new Error('Use the city from this flat’s building address.');
            return { kind: 'flat', xrayBuilding: raw.xrayBuilding, unit: raw.unit, at: raw.at, ...(raw.access ? { access: raw.access } : {}) };
        }
        throw new Error('An offer is for one plot or one flat.');
    }

    function normalizeLens(raw, required) {
        only(raw, ['members', 'threshold'], 'A lens is its members and how many of them must confirm.');
        const members = Array.isArray(raw.members) ? raw.members.map(m => text(m)) : null;
        if (!members || members.length > MAX_LENS || members.some(m => !key(m)) || new Set(members).size !== members.length) {
            throw new Error(`A lens has up to ${MAX_LENS} distinct Solana keys.`);
        }
        if (required && !members.length) throw new Error('A buyer’s lens needs at least one lens member.');
        const threshold = raw.threshold;
        if (!Number.isInteger(threshold) || (members.length ? threshold < 1 || threshold > members.length : threshold !== 0)) {
            throw new Error('The lens threshold is between 1 and the number of lens members (0 without lens members).');
        }
        return { members, threshold };
    }

    function normalizePayout(value) {
        if (!object(value) || !key(value.recipient) || !amount(value.amount)) throw new Error('Every payout needs a recipient and a positive whole amount.');
        return { recipient: value.recipient, amount: value.amount };
    }
    function normalizePayouts(list, price) {
        if (!Array.isArray(list) || !list.length || list.length > MAX_PAYOUTS) throw new Error(`A sale pays 1 to ${MAX_PAYOUTS} recipients.`);
        const payouts = list.map(normalizePayout);
        if (new Set(payouts.map(row => row.recipient)).size !== payouts.length) throw new Error('A payout recipient is listed more than once.');
        if (payouts.reduce((sum, row) => sum + BigInt(row.amount), 0n) !== BigInt(price)) throw new Error('The payouts must add up to the price exactly.');
        return payouts;
    }

    function normalize(raw, { now = Date.now() } = {}) {
        if (!object(raw)) throw new Error('A property offer must be an object.');
        if (raw.schema !== PUBLISHED_SCHEMA) throw new Error(`Expected ${PUBLISHED_SCHEMA}.`);
        const direction = raw.direction;
        if (direction !== 'buy' && direction !== 'sell') throw new Error('Offer direction must be buy or sell.');
        const proposer = text(raw.proposer);
        if (!key(proposer)) throw new Error('The proposer must be a Solana public key.');
        const createdAt = raw.createdAt == null ? new Date(now).toISOString() : raw.createdAt;
        if (!instant(createdAt) || !instant(raw.expiresAt) || Date.parse(raw.expiresAt) <= Date.parse(createdAt)) throw new Error('createdAt and expiresAt must be ISO instants, with expiry after creation.');
        if (!Object.hasOwn(CURRENCIES, raw.currency)) throw new Error('The currency is SOL or USDC.');
        if (!amount(raw.price)) throw new Error('The price is a positive whole number of base units.');
        const city = text(raw.city, MAX_TEXT.city);
        const title = raw.title == null ? null : text(raw.title, MAX_TEXT.title);
        if (!city || (raw.title != null && !title)) throw new Error('city is required and title, when supplied, is non-empty text.');
        const lens = normalizeLens(raw.lens, direction === 'buy');
        let payouts = null;
        if (direction === 'buy' && raw.payouts != null) throw new Error('A buy offer gets its payouts from the seller.');
        if (direction === 'sell') payouts = normalizePayouts(raw.payouts, raw.price);
        return { id: raw.id == null ? null : text(raw.id), schema: PUBLISHED_SCHEMA, ...(title ? { title } : {}), city, createdAt, expiresAt: raw.expiresAt,
            direction, proposer, currency: raw.currency, price: raw.price, lens, asset: normalizeAsset(raw.asset, city), ...(payouts ? { payouts } : {}) };
    }

    function validate(raw, options) { try { normalize(raw, options); return null; } catch (error) { return fail('invalid-property-offer', error.message); } }
    function published(raw, options) { const { id: _id, ...content } = normalize(raw, options); return content; }
    function cid(raw, options) { return cidApi().cidOfObject(published(raw, options)); }
    function newId() { const bytes = new Uint8Array(16); root.crypto.getRandomValues(bytes); return `po-${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`; }

    /** Price text in whole units for people: "1.25" SOL, "250" USDC. */
    function formatAmount(base, currency) {
        const decimals = CURRENCIES[currency]?.decimals; if (decimals == null || base == null) return '';
        const n = BigInt(base), unit = 10n ** BigInt(decimals);
        const fraction = (n % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
        return `${n / unit}${fraction ? `.${fraction}` : ''}`;
    }
    /** Whole units typed by a person to base units; a comma reads as the decimal mark. */
    function parseAmount(value, currency) {
        const decimals = CURRENCIES[currency]?.decimals;
        const textValue = String(value ?? '').trim().replace(',', '.');
        if (decimals == null || !/^\d+(?:\.\d+)?$/.test(textValue)) return null;
        const [whole, fraction = ''] = textValue.split('.');
        if (fraction.length > decimals) return null;
        const base = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
        return base > 0n && base <= 18446744073709551615n ? base.toString() : null;
    }
    return { PUBLISHED_SCHEMA, MAX_PAYOUTS, MAX_LENS, CURRENCIES, assetKey, assetHash, normalizeAsset, normalize, validate, published, cid, newId, formatAmount, parseAmount };
});
