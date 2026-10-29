// The ordered source list of a concept (buildings now; parcels and imagery later): the city's declared
// sources plus any the person adds, each in use or not, and optionally drawn as reference outlines.
// The sources in use stand in for each other in this order, cell by cell (building-cells.js). One
// shape for every city: `buildings: { sources: [{ id, name?, attribution?, use? }] }`
// (docs/source-loading-plan.md, step F). Pure apart from storage, which is injected through `global`.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SourceList = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    const CONCEPTS = {
        buildings: { storage: 'cb_building_sources:', param: 'buildingSources', idPrefix: 'building.', kind: 'building' }
    };
    const EVENT = 'sourceListChanged';
    // Names of the shared sources a city may list without naming them.
    const KNOWN_NAMES = { osm: 'OpenStreetMap', 'gdi-3d': 'Zagreb 3D model (GDI)', dgu: 'DGU cadastre',
        'nyc-arcgis': 'NYC Open Data', 'nyc-socrata': 'NYC Open Data' };

    const conceptOf = concept => {
        const spec = CONCEPTS[concept];
        if (!spec) throw new Error(`Unknown source concept: ${concept}`);
        return spec;
    };

    // A source read in the browser (a public URL adapter descriptor) rather than by our server.
    function isUrlSource(id, concept = 'buildings') {
        return typeof id === 'string' && id.startsWith(conceptOf(concept).idPrefix);
    }

    // The city's declared list: [{ id, name, attribution, use, outline: false, city: true }].
    function cityList(config, concept = 'buildings') {
        const declared = Array.isArray(config?.[concept]?.sources) ? config[concept].sources : [];
        const seen = new Set();
        return declared.filter(entry => entry && typeof entry.id === 'string' && entry.id && !seen.has(entry.id) && seen.add(entry.id))
            .map(entry => ({ id: entry.id, name: entry.name || KNOWN_NAMES[entry.id] || entry.id,
                attribution: entry.attribution || null, use: entry.use !== false, outline: false, city: true }));
    }

    // The effective list: the person's entries in their order (unknown ids dropped), then every city
    // source the person never mentioned, with the city's default. `describe(id)` names a source the
    // person added ({ name } or null when it is not a valid source for this city).
    function resolve(cityEntries, personEntries, describe = () => null) {
        const city = new Map((cityEntries || []).map(entry => [entry.id, entry]));
        const list = [];
        const seen = new Set();
        for (const entry of Array.isArray(personEntries) ? personEntries : []) {
            const id = entry && typeof entry.id === 'string' ? entry.id : null;
            if (!id || seen.has(id)) continue;
            const base = city.get(id) || (() => {
                const described = describe(id);
                return described ? { id, name: described.name || id, attribution: described.attribution || null, city: false } : null;
            })();
            if (!base) continue;
            seen.add(id);
            list.push({ ...base, use: entry.use !== false, outline: entry.outline === true });
        }
        for (const entry of cityEntries || []) if (!seen.has(entry.id)) list.push({ ...entry });
        return list;
    }

    const inUse = list => (list || []).filter(entry => entry.use).map(entry => entry.id);
    // Reference outlines: sources drawn for comparison only, never in use at the same time.
    const outlined = list => (list || []).filter(entry => entry.outline && !entry.use);

    function backend(global) {
        const param = new URLSearchParams(global.location?.search || '').get('backend');
        return String(global.getBackendBase?.() || param || 'https://api.urbangametheory.xyz').replace(/\/+$/, '');
    }
    function storage(global) { return global.BrowserWorkspace?.storage || global.localStorage; }
    function storageKey(cityId, global, concept) { return conceptOf(concept).storage + backend(global) + ':' + cityId; }

    // The person's entries: the URL's `buildingSources=a,b` (those in use, in order, every other
    // listed source not in use), else the stored list, else null (the city's list as declared).
    function personEntries(cityId, global, concept = 'buildings', cityEntries = []) {
        const requested = new URLSearchParams(global.location?.search || '').get(conceptOf(concept).param);
        if (requested) {
            const ids = requested.split(',').map(id => id.trim()).filter(Boolean);
            return [...ids.map(id => ({ id, use: true })),
                ...cityEntries.filter(entry => !ids.includes(entry.id)).map(entry => ({ id: entry.id, use: false }))];
        }
        try {
            const value = JSON.parse(storage(global)?.getItem(storageKey(cityId, global, concept)) || 'null');
            return Array.isArray(value) ? value : null;
        } catch (_) { return null; }
    }

    // A source the person added, named by the settings module's decoder (null when invalid here).
    function describeAdded(cityId, global, concept) {
        const settings = global.ParcelSourceSettings;
        return id => {
            const decoded = settings?.decodeChoice?.(id, cityId, conceptOf(concept).kind);
            return decoded ? { name: decoded.name } : null;
        };
    }

    function forConfig(config, global, concept = 'buildings') {
        const city = cityList(config, concept);
        if (!config?.id || !global) return city;
        return resolve(city, personEntries(config.id, global, concept, city), describeAdded(config.id, global, concept));
    }

    function save(cityId, entries, global, concept = 'buildings') {
        const value = JSON.stringify((entries || []).map(entry => ({ id: entry.id, use: entry.use !== false, outline: entry.outline === true })));
        storage(global).setItem(storageKey(cityId, global, concept), value);
        if (storage(global).getItem(storageKey(cityId, global, concept)) !== value) throw new Error('Source list could not be saved.');
        changed(cityId, global, concept);
    }

    function reset(cityId, global, concept = 'buildings') {
        storage(global).removeItem(storageKey(cityId, global, concept));
        changed(cityId, global, concept);
    }

    // A list given in the URL is the person's for this page: an edit clears it from the address, so the
    // stored list is the one in force from then on.
    function changed(cityId, global, concept) {
        try {
            const url = new URL(global.location.href);
            if (url.searchParams.has(conceptOf(concept).param)) {
                url.searchParams.delete(conceptOf(concept).param);
                global.history?.replaceState?.(global.history.state, '', url.href);
            }
        } catch (_) { /* no address to tidy outside a page */ }
        global.dispatchEvent?.(new global.CustomEvent(EVENT, { detail: { cityId, concept } }));
    }

    return { EVENT, KNOWN_NAMES, isUrlSource, cityList, resolve, inUse, outlined, personEntries, forConfig, save, reset };
});
