// Source-qualified identities for a visitor's register link. A URL identifies this source
// configuration, not a dataset release, jurisdiction or legal status.
(function attachCustomUrlIdentity(root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CustomUrlParcelIdentity = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    function hash(text) {
        const sha = root.Sha256 || (typeof require === 'function' ? require('../bets/sha256.js') : null);
        if (!sha) throw new Error('Custom parcel identity hashing is unavailable.');
        return sha.hex(text);
    }

    function sourceId(url) {
        if (typeof url !== 'string' || !url.trim()) throw new TypeError('A custom source URL is required.');
        return `custom-url:sha256:${hash(url.trim())}`;
    }

    function featureIdentity(feature, source) {
        const sourceHash = /^custom-url:sha256:([a-f0-9]{64})$/.exec(source || '')?.[1];
        if (!sourceHash) throw new TypeError('A qualified custom source ID is required.');
        const props = feature.properties || {};
        // Provider row keys are usable references, not proof of a continuing cadastral entity.
        const candidates = [props.parcelId, props.parcel_id, props.PARCEL_ID, props.id, props.ID,
            props.OBJECTID, props.FID, props.gml_id, feature.id];
        const found = candidates.find(value => (typeof value === 'string' && value.trim()) || Number.isSafeInteger(value));
        const nativeId = found === undefined ? null : String(found).trim();
        // Anonymous identity commits to the exact coordinate encoding and geometry type. It does
        // not equate differently encoded polygons or promise continuity after a geometry edit.
        const reference = nativeId === null
            ? `geometry:${hash(JSON.stringify({ type: feature.geometry.type, coordinates: feature.geometry.coordinates }))}`
            : `native:${encodeURIComponent(nativeId)}`;
        return {
            parcelId: `URL:${sourceHash}:${reference}`,
            sourceId: source,
            sourceParcelId: nativeId,
            sourceIdentityKind: nativeId === null ? 'geometry-content' : 'native-id'
        };
    }

    return { sourceId, featureIdentity };
});
