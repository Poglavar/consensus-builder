// The index row format for city configurations. data/city-index.js holds every city's LIGHT
// configuration as deduplicated tables plus one row per city: scripts/build-city-files.mjs packs it
// with pack(), js/city-config.js rebuilds one city with expand(). Light = full minus DETAIL_KEYS,
// which only the city the page runs in needs; those arrive with its data/cities/<id>.js.
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.__cityLightConfig = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const SCHEMA_VERSION = 1;
    // What the light configuration leaves out: the rare per-city blobs only the current city reads
    // (planning/views.js, the walk and drive launchers, Zagreb's curated roads and transit alignments,
    // the city's default language). Everything else is read for other cities somewhere: parcel
    // attribution by ui/map-credits.js, floorModels and the building fallback by building-source-client.js.
    const DETAIL_KEYS = Object.freeze({
        top: Object.freeze(['planning', 'walk', 'curatedRoads', 'transitAlignments', 'language']),
        parcels: Object.freeze([]),
        buildings: Object.freeze([])
    });
    // Sub-objects shared by many cities, kept once each in a table and referenced by index from the rows.
    const TABLES = Object.freeze(['map', 'projection', 'parcels', 'buildings', 'currency', 'sidebar', 'parcelBuilder']);
    // Row layout: [id, label, wupCityCode|null, lat, lon, one table index per TABLES entry (-1 = absent),
    // extra]. `map` is stored without defaultCenter and `projection` without the fallbacks that equal
    // the centre, so most cities share a handful of table entries. `extra` holds every other light key
    // (explore, countryCode) or 0.
    const FIXED = 5;

    function omit(object, keys) {
        const copy = {};
        for (const key of Object.keys(object)) if (!keys.includes(key)) copy[key] = object[key];
        return copy;
    }
    // A key-order-independent serialisation, for deduplication and for comparing configurations.
    function stable(value) {
        return JSON.stringify(value, (_key, item) => {
            if (item === Infinity) return '@@Infinity@@';
            if (item === -Infinity) return '@@-Infinity@@';
            if (item && typeof item === 'object' && !Array.isArray(item)) {
                return Object.keys(item).sort().reduce((sorted, key) => { sorted[key] = item[key]; return sorted; }, {});
            }
            return item;
        });
    }
    function sameArray(a, b) {
        return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => item === b[i]);
    }

    // The light configuration of a full one.
    function lightOf(config) {
        const light = omit(config, DETAIL_KEYS.top);
        if (light.parcels) light.parcels = omit(light.parcels, DETAIL_KEYS.parcels);
        if (light.buildings) light.buildings = omit(light.buildings, DETAIL_KEYS.buildings);
        return light;
    }

    // Every city's light configuration packed into the index: { schemaVersion, tables, rows }.
    function pack(configs) {
        const tables = {};
        const keys = {};
        for (const name of TABLES) { tables[name] = []; keys[name] = new Map(); }
        const ref = (name, value) => {
            const key = stable(value);
            if (!keys[name].has(key)) { keys[name].set(key, tables[name].length); tables[name].push(value); }
            return keys[name].get(key);
        };
        const rows = Object.keys(configs).map(id => {
            const light = lightOf(configs[id]);
            if (light.id !== id) throw new Error(`city ${id}: its id field says ${light.id}`);
            const center = light.map && light.map.defaultCenter;
            if (!Array.isArray(center) || center.length !== 2 || !center.every(Number.isFinite)) {
                throw new Error(`city ${id}: map.defaultCenter missing`);
            }
            const [lat, lon] = center;
            const parts = {};
            const extra = {};
            for (const [key, value] of Object.entries(light)) {
                if (key === 'id' || key === 'label' || key === 'wupCityCode') continue;
                if (key === 'map') { parts.map = omit(value, ['defaultCenter']); continue; }
                if (key === 'projection') {
                    const projection = { ...value };
                    if (sameArray(projection.fallbackLatLng, [lat, lon])) delete projection.fallbackLatLng;
                    if (sameArray(projection.fallbackDataset, [lon, lat])) delete projection.fallbackDataset;
                    parts.projection = projection;
                    continue;
                }
                if (TABLES.includes(key)) { parts[key] = value; continue; }
                extra[key] = value;
            }
            const row = [id, light.label, light.wupCityCode ?? null, lat, lon];
            for (const name of TABLES) row.push(parts[name] === undefined ? -1 : ref(name, parts[name]));
            row.push(Object.keys(extra).length ? extra : 0);
            return row;
        });
        return { schemaVersion: SCHEMA_VERSION, tables, rows };
    }

    // One city's light configuration from its row. Table entries are shared, not copied.
    function expand(index, row) {
        if (!index || index.schemaVersion !== SCHEMA_VERSION) {
            throw new Error(`city index schema ${index && index.schemaVersion} is not ${SCHEMA_VERSION}`);
        }
        const [id, label, wupCityCode, lat, lon] = row;
        const config = { id, label };
        if (wupCityCode !== null) config.wupCityCode = wupCityCode;
        TABLES.forEach((name, i) => {
            const at = row[FIXED + i];
            if (at >= 0) config[name] = index.tables[name][at];
        });
        config.map = { ...config.map, defaultCenter: [lat, lon] };
        // Fallbacks were dropped where they equal the centre; a city without a projection stays without one.
        if (config.projection) {
            const projection = { ...config.projection };
            if (!projection.fallbackLatLng) projection.fallbackLatLng = [lat, lon];
            if (!projection.fallbackDataset) projection.fallbackDataset = [lon, lat];
            config.projection = projection;
        }
        const extra = row[FIXED + TABLES.length];
        if (extra) Object.assign(config, extra);
        return config;
    }

    return { SCHEMA_VERSION, DETAIL_KEYS, TABLES, lightOf, pack, expand, stable };
});
