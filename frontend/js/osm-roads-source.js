// OSM roads and railways for the 2D road tools (Detect Existing Roads, Draw Roads from OSM, the OSM
// road lines toggle, road analysis), read through our backend's /osm-road: the ingested osm_road
// table, else the backend's Overpass chain (the paid Tracestrack instance, whose key stays on the
// server). Answers come back in the Overpass `out body geom` shape the tools already read. Only
// when our server itself cannot answer does the caller ask public Overpass directly.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.OsmRoadsSource = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // Just inside the backend's 0.06° scene limit, so a tile is never clipped there.
    const TILE_SPAN_DEG = 0.05;
    // A viewport needing more tiles than this is a region, not something to detect roads in.
    const MAX_TILES = 16;
    // The classes the old browser query took without a name; any named highway and every railway count too.
    const UNNAMED_HIGHWAYS = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential',
        'unclassified', 'service', 'living_street']);

    /** [w, s, e, n] → tiles no wider or taller than TILE_SPAN_DEG; null when that takes more than MAX_TILES. */
    function tileBbox([w, s, e, n], span = TILE_SPAN_DEG, maxTiles = MAX_TILES) {
        if (!(e > w && n > s)) return [];
        const cols = Math.ceil((e - w) / span), rows = Math.ceil((n - s) / span);
        if (cols * rows > maxTiles) return null;
        const tiles = [];
        for (let r = 0; r < rows; r += 1) {
            for (let c = 0; c < cols; c += 1) {
                tiles.push([w + c * (e - w) / cols, s + r * (n - s) / rows, w + (c + 1) * (e - w) / cols, s + (r + 1) * (n - s) / rows]);
            }
        }
        return tiles;
    }

    function wanted(tags) {
        if (tags.railway) return true;
        return !!tags.highway && (!!tags.name || UNNAMED_HIGHWAYS.has(tags.highway));
    }

    /** /osm-road features → Overpass-style way elements, once per OSM way, filtered as the old query was. */
    function featuresToElements(features) {
        const elements = [];
        const seen = new Set();
        for (const feature of features || []) {
            const props = feature && feature.properties || {};
            const geometry = feature && feature.geometry;
            if (!geometry || geometry.type !== 'LineString' || !Array.isArray(geometry.coordinates) || geometry.coordinates.length < 2) continue;
            const id = props.osm_id;
            if (id !== undefined && id !== null) {
                if (seen.has(String(id))) continue;
                seen.add(String(id));
            }
            const tags = { ...(props.tags || {}) };
            if (props.highway_type && !tags.highway) tags.highway = props.highway_type;
            if (props.railway_type && !tags.railway) tags.railway = props.railway_type;
            if (props.name && !tags.name) tags.name = props.name;
            if (!wanted(tags)) continue;
            elements.push({
                type: 'way',
                id,
                tags,
                nodes: Array.isArray(props.osm_node_ids) ? props.osm_node_ids : undefined,
                geometry: geometry.coordinates.map(([lon, lat]) => ({ lat, lon }))
            });
        }
        return elements;
    }

    /**
     * Roads and railways for a WGS84 box from our backend, as { elements, partial, tooLarge }.
     * Throws with `backendUnavailable: true` when our server cannot answer (network error, HTTP error),
     * which is the only case the caller may go to public Overpass instead.
     */
    async function fetchFromBackend(bbox, { base = '', fetchImpl = fetch } = {}) {
        const tiles = tileBbox(bbox);
        if (tiles === null) return { elements: [], partial: false, tooLarge: true };
        const answers = await Promise.all(tiles.map(async ([w, s, e, n]) => {
            let response;
            try {
                response = await fetchImpl(`${base.replace(/\/$/, '')}/osm-road?bbox=${w},${s},${e},${n}&crs=EPSG:4326&railways=1`);
            } catch (error) {
                throw Object.assign(new Error(`our server did not answer /osm-road: ${error && error.message ? error.message : error}`), { backendUnavailable: true });
            }
            if (!response.ok) throw Object.assign(new Error(`our server answered /osm-road with HTTP ${response.status}`), { backendUnavailable: true });
            return response.json();
        }));
        const features = answers.flatMap(answer => (answer && Array.isArray(answer.features)) ? answer.features : []);
        // `overpass: 'unavailable'` means our server is up but its Overpass chain could not answer either.
        const partial = answers.some(answer => answer && (answer.partial || answer.truncated || answer.overpass === 'unavailable'));
        return { elements: featuresToElements(features), partial, tooLarge: false };
    }

    return { tileBbox, featuresToElements, fetchFromBackend, TILE_SPAN_DEG, MAX_TILES };
});
