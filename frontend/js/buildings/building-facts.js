// Building facts for the building card: what the shared API's building-facts contract
// (GET /api/building-facts) knows about a building — storeys, when it was built, roof shape,
// parapet — each with its source, and where to add a missing one. The app knows only the contract;
// which source answers (OpenStreetMap today) is the shared API's business.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.BuildingFacts = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const API_ROOT = 'https://zagreb.lol/api';
    // The facts the card lists, in order (the contract also answers height_m, which the card's
    // height line already covers).
    const CARD_FIELDS = Object.freeze(['storeys', 'built', 'roof_shape', 'parapet']);
    const OSM_ID = /^(?:osm:)?([wr])([1-9][0-9]{0,15})$/;

    // The contract's id for a building the map drew: OSM buildings carry their element id
    // ('w123', 'r45'). Null for buildings of other sources, which the contract does not yet answer.
    function factIdOf(feature, key) {
        const p = feature?.properties || {};
        for (const candidate of [feature?.id, p.osm_id, p.object_id, p.id, key]) {
            const match = OSM_ID.exec(String(candidate ?? ''));
            if (match) return `osm:${match[1] === 'w' ? 'way' : 'relation'}/${match[2]}`;
        }
        return null;
    }

    // The shared API's address; on a local page `?sharedApi=` may point it at a local copy.
    function apiRoot(location = typeof window !== 'undefined' ? window.location : null) {
        if (!location || !['localhost', '127.0.0.1'].includes(location.hostname)) return API_ROOT;
        const local = new URLSearchParams(location.search).get('sharedApi');
        return local && /^http:\/\/(localhost|127\.0\.0\.1):\d+\/api$/.test(local) ? local : API_ROOT;
    }

    // Several buildings' facts, read live (the contract reads its source on every request), as a Map
    // id → building; at most 200 per request, as the contract allows.
    async function readMany(ids, { fetchFn = fetch, base = apiRoot() } = {}) {
        const found = new Map();
        for (let i = 0; i < ids.length; i += 200) {
            const batch = ids.slice(i, i + 200);
            const response = await fetchFn(`${base}/building-facts?ids=${batch.map(encodeURIComponent).join(',')}`, { cache: 'no-store' });
            if (!response.ok) throw new Error(`Building facts HTTP ${response.status}`);
            const answer = await response.json();
            for (const id of batch) {
                const building = (answer.buildings || []).find(item => item.id === id);
                if (!building || typeof building.facts !== 'object') throw new Error('Invalid building facts response');
                found.set(id, { ...building, sources: answer.sources || [] });
            }
        }
        return found;
    }
    // One building's facts.
    async function read(id, options = {}) {
        return (await readMany([id], options)).get(id);
    }

    // { from, to } (whole years, either open) → the words for it.
    function builtWords(span, t) {
        const { from, to } = span || {};
        if (from != null && from === to) return String(from);
        if (from == null && to != null) return t('builtBefore', { year: to + 1 });
        if (from != null && to == null) return t('builtAfter', { year: from });
        if (from != null && to != null) return t('builtBetween', { from, to });
        return null;
    }

    // A roof shape is shown in the source's own word (OSM's roof:shape values).
    function valueWords(field, value, t) {
        if (field === 'built') return builtWords(value, t);
        if (field === 'parapet') return value ? t('parapetYes') : t('parapetNo');
        return String(value);
    }

    // The card's rows: each field's label, its value in words (null when unknown), and the source's
    // key (where it was read, or where to add it when missing) with the raw text behind it.
    function cardRows(building, t) {
        return CARD_FIELDS.map(field => {
            const fact = building.facts[field];
            return { field, label: t(`field.${field}`), text: fact ? valueWords(field, fact.value, t) : null,
                key: fact?.key || building.edit?.keys?.[field] || null, raw: fact?.raw ?? null };
        });
    }

    return { API_ROOT, CARD_FIELDS, factIdOf, apiRoot, read, readMany, builtWords, cardRows };
});
