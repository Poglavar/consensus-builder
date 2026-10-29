// What a building is for, by storey: the Use of a design's building (`properties.use`), shared by
// the Freeform editor, MCP intents, the suggested default layouts and Plan stats. A use is one of
// six presets; free text from older designs or agents ('office', 'housing', 'school') reads as
// the preset it names, and anything else as no stated use.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.BuildingUse = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    // Ground floor first. 'shop' and 'office' are work; 'public' and 'industrial' too.
    const USES = Object.freeze(['residential', 'residential-shops', 'mixed', 'office', 'public', 'industrial']);
    const SYNONYMS = Object.freeze({
        residential: ['housing', 'apartments', 'apartment', 'flats', 'homes', 'dwelling', 'dwellings', 'house', 'houses'],
        'residential-shops': ['residential with shops', 'shops below', 'retail ground floor'],
        mixed: ['mixed-use', 'mixed use'],
        office: ['offices', 'commercial', 'business'],
        public: ['civic', 'school', 'education', 'health', 'clinic', 'hospital', 'community', 'library'],
        industrial: ['industry', 'warehouse', 'workshop', 'logistics', 'factory']
    });
    const lookup = new Map();
    USES.forEach(use => { lookup.set(use, use); SYNONYMS[use].forEach(word => lookup.set(word, use)); });

    // The preset a value names, or null.
    function normalize(value) {
        if (typeof value !== 'string') return null;
        return lookup.get(value.trim().toLowerCase().replace(/_/g, '-')) || null;
    }

    // The use of each storey, ground floor first: residential-shops has shops on the ground floor,
    // mixed has shops on the ground floor and offices on the first.
    function storeyUses(use, floors) {
        const key = normalize(use);
        const n = Number.isInteger(floors) && floors > 0 ? floors : 0;
        if (!key || !n) return [];
        const lower = { residential: [], 'residential-shops': ['shop'], mixed: ['shop', 'office'] }[key];
        if (!lower) return new Array(n).fill(key);
        return Array.from({ length: n }, (_, level) => lower[level] || 'residential');
    }

    // The share of a building's storeys that are housing, or null when no use is stated.
    function housingShare(use, floors) {
        const storeys = storeyUses(use, floors);
        if (!storeys.length) return null;
        return storeys.filter(storey => storey === 'residential').length / storeys.length;
    }

    // Whether the suggested default layout (a housing layout) applies: only to housing uses.
    const housesPeople = use => ['residential', 'residential-shops', 'mixed'].includes(normalize(use));

    // The generator's rules for a housing use: shops on the ground floor where the use has them.
    function layoutRules(use) {
        const key = normalize(use);
        if (!housesPeople(key)) return null;
        return { groundFloorUse: key === 'residential' ? 'residential' : 'commercial' };
    }

    return { USES, normalize, storeyUses, housingShare, housesPeople, layoutRules };
});
