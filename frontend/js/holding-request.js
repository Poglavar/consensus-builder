// A person's signed request that lens members state it holds a plot or a flat
// (property-holding-request/v1). The browser, the MCP tools and the server build the exact text the
// claimant's wallet signs here, so a signature made in one verifies in the others. Whether a lens
// member answered is read from chain (its PropertyHolding-v1 statement for the asset), not stored.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.HoldingRequest = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const SCHEMA = 'property-holding-request/v1';
    const MAX_LENS = 8;
    const MAX_NOTE = 1000;
    const offers = () => root.PropertyOfferRecord || (typeof require === 'function' ? require('./property-offer-record.js') : null);
    const base58 = () => root.LensCore || (typeof require === 'function' ? require('./lens-core.js') : null);
    const key = value => !!base58()?.isBase58Pubkey?.(value) && value === value.trim();
    const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;

    /** The request in canonical form (lens members sorted); throws on anything malformed. */
    function normalize(raw) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('A holding request must be an object.');
        const extra = Object.keys(raw).filter(name => !['city', 'asset', 'claimant', 'lensMembers', 'note', 'createdAt'].includes(name));
        if (extra.length) throw new Error(`Unknown holding request field: ${extra.join(', ')}.`);
        const city = typeof raw.city === 'string' && raw.city.trim() ? raw.city.trim() : null;
        if (!city || city.length > 100) throw new Error('A holding request names its city.');
        const asset = offers().normalizeAsset(raw.asset, city);
        if (!key(raw.claimant)) throw new Error('The claimant must be a Solana public key.');
        const members = raw.lensMembers;
        if (!Array.isArray(members) || !members.length || members.length > MAX_LENS || members.some(member => !key(member)) || new Set(members).size !== members.length) {
            throw new Error(`Ask 1 to ${MAX_LENS} distinct lens members (Solana keys).`);
        }
        if (raw.note != null && (typeof raw.note !== 'string' || raw.note.length > MAX_NOTE)) throw new Error(`The note is text of up to ${MAX_NOTE} characters.`);
        if (!instant(raw.createdAt)) throw new Error('createdAt must be an ISO instant.');
        return { city, asset, claimant: raw.claimant, lensMembers: [...members].sort(), ...(raw.note ? { note: raw.note } : {}), createdAt: raw.createdAt };
    }

    /** The exact text the claimant signs. */
    function message(raw) {
        const request = normalize(raw);
        return JSON.stringify([SCHEMA, offers().assetKey(request.asset), request.claimant, request.lensMembers, request.createdAt, request.note || '']);
    }

    return { SCHEMA, MAX_LENS, MAX_NOTE, normalize, message };
});
