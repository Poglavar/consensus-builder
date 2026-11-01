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

    // A Block, Row or Detached ('parcelBased') rule building states no use: it is housing, and the
    // suggested layout's own rule (default-floor-plans.js) gives a Block building of five storeys or
    // more shops on the ground floor.
    const HOUSING_TYPOLOGIES = Object.freeze(['block', 'row', 'parcelBased']);
    const autoGroundFloorUse = (typology, floors) => (typology === 'block' && floors >= 5 ? 'commercial' : 'residential');

    // The use a building states: a Block, Row or Detached design's building takes its rule's Use
    // (`urbanRule.use`) and nothing else; any other building its own (a Freeform building's Use,
    // an existing building's source use); null when none is stated.
    function statedUse(properties) {
        const props = properties || {};
        if (props.urbanRule) return normalize(props.urbanRule.use);
        return normalize(props.use);
    }

    // The use a building of `floors` storeys has: its stated use, else a housing rule's (residential,
    // with shops below where the suggested layout puts them), else null.
    function effectiveUse(properties, floors) {
        const props = properties || {};
        const stated = statedUse(props);
        if (stated) return stated;
        const typology = props.urbanRule && props.urbanRule.typology;
        if (!HOUSING_TYPOLOGIES.includes(typology)) return null;
        return autoGroundFloorUse(typology, floors) === 'commercial' ? 'residential-shops' : 'residential';
    }

    // The use of each storey of a building (its properties), ground floor first; [] for no use.
    function storeyUsesOf(properties, floors) {
        const use = effectiveUse(properties, floors);
        return use ? storeyUses(use, floors) : [];
    }

    // A city model's building function code → one of the six uses. The German states' LoD2 models
    // write ALKIS building functions as "31001_<code>" (31001 is the ALKIS building class); SIG3D's
    // CityGML code list uses the same four-digit codes bare. Ranges by the list's own grouping: 1xxx
    // housing (11xx with other uses), 2xxx trade, industry and utilities, 3xxx public; 13xx holiday
    // and garden houses, 9998 unknown and 9999 other state no use.
    const ALKIS_USES = Object.freeze([
        [1000, 1099, 'residential'], [1100, 1100, 'mixed'], [1110, 1110, 'residential'], [1120, 1120, 'residential-shops'],
        [1121, 1122, 'mixed'], [1123, 1123, 'residential-shops'], [1130, 1131, 'residential-shops'], [1200, 1299, 'residential'],
        [2000, 2099, 'office'], [2100, 2299, 'industrial'], [2310, 2320, 'mixed'], [2400, 2799, 'industrial'],
        [3000, 3099, 'public'], [3100, 3100, 'public'], [3200, 3299, 'public']
    ]);
    function alkisUse(code) {
        const match = /^(?:31001_)?(\d{4})$/.exec(String(code).trim());
        if (!match) return null;
        const number = Number(match[1]);
        const range = ALKIS_USES.find(([from, to]) => number >= from && number <= to);
        return range ? range[2] : null;
    }

    // The use a city model states for a building: its function code or word, else its usage; null
    // when neither names one. Other ALKIS classes (51009 canopies and other structures, 53001
    // bridges) are not buildings with a use.
    function fromCityModel(functionCode, usageCode) {
        for (const value of [functionCode, usageCode]) {
            if (value === null || value === undefined || value === '') continue;
            const use = alkisUse(value) || normalize(String(value));
            if (use) return use;
        }
        return null;
    }

    // OpenStreetMap's building=* value (also Overture's class and subtype, which use the same words)
    // → one of the six uses. building=yes, sheds, garages, roofs and farm buildings state none.
    const OSM_USES = Object.freeze({
        residential: ['apartments', 'house', 'residential', 'detached', 'semidetached_house', 'semi', 'terrace',
            'dwelling_house', 'bungalow', 'dormitory', 'farm', 'cabin', 'houseboat', 'static_caravan', 'stilt_house'],
        office: ['office', 'commercial', 'retail', 'supermarket', 'kiosk', 'hotel'],
        industrial: ['industrial', 'warehouse', 'factory', 'manufacture', 'hangar'],
        public: ['public', 'civic', 'government', 'school', 'kindergarten', 'college', 'university', 'education',
            'hospital', 'medical', 'library', 'fire_station', 'post_office', 'train_station', 'transportation',
            'church', 'cathedral', 'chapel', 'mosque', 'synagogue', 'temple', 'religious', 'monastery',
            'sports_hall', 'sports_centre', 'stadium']
    });
    const osmLookup = new Map();
    Object.entries(OSM_USES).forEach(([use, words]) => words.forEach(word => osmLookup.set(word, use)));
    function fromOsmBuilding(value) {
        if (typeof value !== 'string') return null;
        return osmLookup.get(value.trim().toLowerCase()) || null;
    }

    return { USES, HOUSING_TYPOLOGIES, normalize, statedUse, effectiveUse, storeyUses, storeyUsesOf, autoGroundFloorUse, housingShare, housesPeople,
        layoutRules, fromCityModel, fromOsmBuilding };
});
