(function (global) {
    'use strict';

    function coerceId(value) {
        if (value === undefined || value === null) return null;
        return String(value).trim();
    }

    function ensureParcelId(target) {
        if (!target) return null;
        const props = target.properties || target;
        if (!props || typeof props !== 'object') return null;

        const parcelId = coerceId(
            props.parcelId
            ?? props.parcel_id
            ?? props.id
        );

        if (!parcelId) return null;

        props.parcelId = parcelId;
        if (!props.id) {
            props.id = parcelId;
        }

        return parcelId;
    }

    function getParcelId(input) {
        if (input && typeof input === 'object' && 'properties' in input) {
            return ensureParcelId(input);
        }
        if (input && typeof input === 'object') {
            return ensureParcelId({ properties: input });
        }
        return coerceId(input);
    }

    global.ensureParcelId = ensureParcelId;
    global.getParcelId = getParcelId;

    // Also export for node, so these pure helpers can be unit-tested without a browser
    // (backend/test/parcel-id.test.js). The browser path above is unchanged.
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { ensureParcelId, getParcelId };
    }
})(typeof window !== 'undefined' ? window : globalThis);
