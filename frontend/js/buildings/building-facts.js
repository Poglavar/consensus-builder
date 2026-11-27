// Building facts for the building card: what the shared API's building-facts contract
// (GET /api/building-facts) knows about a building — storeys, when it was built, roof shape,
// parapet, heritage listing — each with its source, and where to add a missing one. The app knows only the contract;
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
    const CARD_FIELDS = Object.freeze(['storeys', 'built', 'roof_shape', 'parapet', 'heritage']);
    // Facts that come from a register rather than the editable map: no key to add them under.
    const REGISTER_FIELDS = Object.freeze(['heritage']);
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

    // Several buildings' facts as a Map id → building; at most 200 per request, as the contract
    // allows. The API keeps a read 5 minutes; fresh asks the source again ("Check again" after an edit).
    async function readMany(ids, { fetchFn = fetch, base = apiRoot(), fresh = false } = {}) {
        const found = new Map();
        for (let i = 0; i < ids.length; i += 200) {
            const batch = ids.slice(i, i + 200);
            const response = await fetchFn(`${base}/building-facts?ids=${batch.map(encodeURIComponent).join(',')}${fresh ? '&fresh=1' : ''}`, { cache: 'no-store' });
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

    // A heritage listing in words: listed with the grade the register states, or not listed.
    function heritageWords(value, t) {
        if (!value.listed) return t('heritageNotListed');
        return value.grade ? t('heritageListed', { grade: value.grade }) : t('heritageListedNoGrade');
    }
    // A roof shape is shown in the source's own word (OSM's roof:shape values).
    function valueWords(field, value, t) {
        if (field === 'built') return builtWords(value, t);
        if (field === 'parapet') return value ? t('parapetYes') : t('parapetNo');
        if (field === 'heritage') return heritageWords(value, t);
        return String(value);
    }
    const UNKNOWN_REASONS = Object.freeze(['no-register', 'no-region', 'no-outline', 'row-uncertain', 'number-ambiguous', 'outline-uncertain', 'register-incomplete', 'register-unavailable']);
    // Where a register fact was read: the register entry that lists the building, the register
    // itself for "not listed", or the entry that may cover it while it is unknown.
    function registerLink(field, building, t) {
        const fact = building.facts[field];
        if (fact?.value?.url) return { url: fact.value.url, text: fact.value.reference ? t('heritageEntry', { reference: fact.value.reference }) : t('heritageRegister') };
        const entry = building.unknown_reasons?.[field]?.entries?.[0];
        return entry?.url ? { url: entry.url, text: entry.reference ? t('heritageEntry', { reference: entry.reference }) : t('heritageRegister') } : null;
    }

    // The card's rows: each field's label, its value in words (null when unknown), and the source's
    // key (where it was read, or where to add it when missing) with the raw text behind it. A
    // register fact has no key to add it under; it carries a link to its register entry instead, and
    // when unknown, the reason the source gives (in words, by its code).
    function cardRows(building, t) {
        return CARD_FIELDS.map(field => {
            const fact = building.facts[field];
            const row = { field, label: t(`field.${field}`), text: fact ? valueWords(field, fact.value, t) : null,
                key: fact?.key || (REGISTER_FIELDS.includes(field) ? null : building.edit?.keys?.[field] || null), raw: fact?.raw ?? null };
            if (!REGISTER_FIELDS.includes(field)) return row;
            const code = building.unknown_reasons?.[field]?.code;
            return { ...row, link: registerLink(field, building, t), reason: !fact && UNKNOWN_REASONS.includes(code) ? t(`heritageUnknown.${code.replace(/-(\w)/g, (_, c) => c.toUpperCase())}`) : null };
        });
    }

    return { API_ROOT, CARD_FIELDS, factIdOf, apiRoot, read, readMany, builtWords, heritageWords, cardRows };
});
