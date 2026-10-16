// Pure presentation helpers for machine-derived proposal and parcel identifiers.
(function (global) {
    'use strict';

    const GEOMETRY_ID = /^([a-z0-9]+(?:-[a-z0-9]+)*)-g1~(-?(?:0|[1-9]\d*))~(-?(?:0|[1-9]\d*))~([0-9a-f]{64})$/i;
    const EMBEDDED_GEOMETRY_ID = /([a-z0-9]+(?:-[a-z0-9]+)*)-g1~-?(?:0|[1-9]\d*)~-?(?:0|[1-9]\d*)~([0-9a-f]{64})(?![0-9a-f])/gi;
    const GENERATED_TITLE = /^(\d+-storey (?:infill|alternative) on parcel )/i;

    function valueText(value) {
        return value === undefined || value === null ? '' : String(value);
    }

    function parcelLabel(id) {
        const raw = valueText(id);
        const match = GEOMETRY_ID.exec(raw);
        return match ? `G1-${match[4].slice(0, 8).toLowerCase()}` : raw;
    }

    function geometryParcelIds(proposal) {
        return (Array.isArray(proposal?.cadastreParcelIds) ? proposal.cadastreParcelIds : [])
            .map(valueText)
            .filter(id => GEOMETRY_ID.test(id));
    }

    function replaceOldGeneratedTitle(value, ids) {
        const title = GENERATED_TITLE.exec(value);
        if (!title) return value;
        const prefix = title[1];
        const suffix = value.slice(prefix.length);
        for (const id of ids) {
            const identity = GEOMETRY_ID.exec(id);
            if (!identity) continue;
            const oldParcelTail = id.slice(id.lastIndexOf('-') + 1);
            if (!suffix || !oldParcelTail.startsWith(suffix)) continue;
            return `${prefix}${parcelLabel(id)}`;
        }
        return value;
    }

    function text(value, proposal) {
        const raw = replaceOldGeneratedTitle(valueText(value), geometryParcelIds(proposal));
        return raw.replace(EMBEDDED_GEOMETRY_ID, (_id, _source, hash) => `G1-${hash.slice(0, 8).toLowerCase()}`);
    }

    const api = Object.freeze({ text, parcelLabel });
    if (typeof window !== 'undefined') window.ProposalDisplayText = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
