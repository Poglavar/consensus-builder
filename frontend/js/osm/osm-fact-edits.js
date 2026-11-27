// Adding missing building facts from the app: which facts a person can state here (with the choices
// offered and the fact each choice means), and saving them to OpenStreetMap as that person's edit
// (osm/osm-account.js signs in, osm/osm-edit.js writes one changeset). The tag key is the one the
// shared API's contract names for the field (building.edit.keys), so this module holds no key list.
// After a save the buildings are shown as the saved tags state them (BuildingFacts.remember) until
// the source has the new version. People only: agents read facts but do not edit OSM (its policy
// treats AI-agent edits as automated edits needing community approval).
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.OsmFactEdits = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const dep = (name, path) => (root && root[name]) || require(path);

    // Choices are OSM values; roof shapes are the common roof:shape values, in OSM's own words.
    const ROOF_SHAPES = ['flat', 'gabled', 'hipped', 'butterfly', 'mansard', 'skillion', 'half-hipped', 'gambrel', 'pyramidal', 'saltbox', 'round', 'dome'];
    const EDITABLE = Object.freeze({
        parapet: { choices: [{ tag: 'yes', value: true }, { tag: 'no', value: false }] },
        roof_shape: { choices: ROOF_SHAPES.map(tag => ({ tag, value: tag })) },
        storeys: { integer: { min: 1, max: 60 } },
    });

    // Fields of a building that are unknown, editable here, and that its source names a key for.
    function missingEditable(building, fields = Object.keys(EDITABLE)) {
        if (!building?.found || building.edit?.source !== 'OpenStreetMap') return [];
        return fields.filter(field => EDITABLE[field] && !building.facts?.[field] && building.edit?.keys?.[field]);
    }

    // A chosen tag value → the fact it states, or null when it is not one of the field's choices.
    function factValue(field, tag) {
        const def = EDITABLE[field];
        if (!def) return null;
        if (def.integer) {
            const n = Number(tag);
            return Number.isInteger(n) && n >= def.integer.min && n <= def.integer.max ? n : null;
        }
        return def.choices.find(choice => choice.tag === tag)?.value ?? null;
    }

    // entries: [{ building, values: { field: tag } }] → OSM edits [{ id, tags }] (empty values skipped).
    function editsOf(entries) {
        return entries.map(({ building, values }) => {
            const tags = {};
            for (const [field, tag] of Object.entries(values || {})) {
                if (tag === '' || tag == null) continue;
                if (factValue(field, tag) === null) throw new Error(`Not a choice for ${field}: ${tag}`);
                tags[building.edit.keys[field]] = String(tag);
            }
            return { id: building.id, tags };
        }).filter(edit => Object.keys(edit.tags).length);
    }

    // The building as the saved tags state it, at the new version.
    function withSaved(building, values, version, changed) {
        const facts = { ...building.facts };
        for (const [field, tag] of Object.entries(values || {})) {
            if (tag === '' || tag == null) continue;
            facts[field] = { value: factValue(field, tag), source: 'osm', key: building.edit.keys[field], raw: String(tag) };
        }
        return { ...building, facts, source_version: { version, changed } };
    }

    // Save the entries to OSM as the signed-in person, signing in first if needed (call from the
    // click, so the sign-in window is not blocked). Resolves { changeset, buildings: Map id → building }.
    async function save(entries, { comment, account = dep('OsmAccount', './osm-account.js'), edit = dep('OsmEdit', './osm-edit.js'),
        facts = dep('BuildingFacts', '../buildings/building-facts.js'), now = () => new Date().toISOString() } = {}) {
        const edits = editsOf(entries);
        if (!edits.length) throw new Error('Choose at least one fact to save.');
        if (!account.token()) await account.signIn();
        let result;
        try {
            result = await edit.saveTags(edits, { token: account.token(), comment });
        } catch (error) {
            // A revoked or expired token: forget it, so the next save signs in again.
            if (/HTTP 401/.test(error.message)) account.signOut();
            throw error;
        }
        const buildings = new Map();
        for (const { building, values } of entries) {
            const version = result.versions.get(building.id);
            if (!Number.isInteger(version)) continue;
            const saved = withSaved(building, values, version, now());
            facts.remember(saved);
            buildings.set(building.id, saved);
        }
        return { changeset: result.changeset, buildings };
    }

    // The changeset comment: what was added, to how many buildings, and why.
    function commentFor(entries, purpose) {
        const edits = editsOf(entries);
        const keys = [...new Set(edits.flatMap(edit => Object.keys(edit.tags)))].join(', ');
        return `Add ${keys} to ${edits.length} building${edits.length === 1 ? '' : 's'}${purpose ? ` (${purpose})` : ''}`;
    }

    return { EDITABLE, ROOF_SHAPES, missingEditable, factValue, editsOf, withSaved, save, commentFor };
});
