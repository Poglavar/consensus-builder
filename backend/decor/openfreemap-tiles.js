// OpenFreeMap's vector tiles (OpenStreetMap data in the OpenMapTiles schema, free, no key), read for
// the 3D scene's scenery: which z14 tiles cover a scene, and one cached reader shared by every layer
// read from them (water, green areas), so a tile is fetched once and named layers decode on demand.

import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';

const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
// The tile address carries the weekly build, so it is looked up again once a day.
const TEMPLATE_TTL_MS = 24 * 60 * 60 * 1000;
// z14 is the deepest zoom OpenFreeMap serves; one tile is ~2.4 km across at the equator, so a scene
// needs one to four.
export const ZOOM = 14;
const TILE_TTL_MS = 6 * 60 * 60 * 1000;
const TILE_CACHE_MAX = 300;
const FETCH_TIMEOUT_MS = 15000;

// The z/x/y tiles covering a WGS84 bbox [w, s, e, n].
export function tilesForBbox([w, s, e, n], z = ZOOM) {
    const count = 2 ** z;
    const x = lon => Math.min(count - 1, Math.max(0, Math.floor((lon + 180) / 360 * count)));
    const y = lat => {
        const rad = lat * Math.PI / 180;
        return Math.min(count - 1, Math.max(0, Math.floor((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2 * count)));
    };
    const tiles = [];
    for (let tx = x(w); tx <= x(e); tx++) {
        for (let ty = y(n); ty <= y(s); ty++) tiles.push({ z, x: tx, y: ty });
    }
    return tiles;
}

// The WGS84 rectangle of one Web Mercator tile. Overview scenery reads the source at a coarser
// native tile zoom, so the tile itself is also its stable, cacheable response boundary.
export function tileBbox(z, x, y) {
    const count = 2 ** z;
    if (!Number.isInteger(z) || z < 0 || z > ZOOM || !Number.isInteger(x) || !Number.isInteger(y)
        || x < 0 || y < 0 || x >= count || y >= count) return null;
    const lon = column => column / count * 360 - 180;
    const lat = row => Math.atan(Math.sinh(Math.PI * (1 - 2 * row / count))) * 180 / Math.PI;
    return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}

export function createTileReader({ fetchImpl = fetch, now = Date.now } = {}) {
    let template = null;
    // tile URL → { at, parsed: Promise<VectorTile>, layers: Map<name, Promise<Feature[]>> }
    // The vector tile itself is parsed once. Each named source layer is converted to GeoJSON only
    // when a consumer requests it, so regional water does not decode labels, buildings or land use.
    const tiles = new Map();

    async function fetchWithTimeout(url) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const response = await fetchImpl(url, { signal: controller.signal });
            if (!response.ok) throw Object.assign(new Error(`OpenFreeMap HTTP ${response.status}`), { status: 502 });
            return response;
        } finally {
            clearTimeout(timer);
        }
    }

    async function tileTemplate() {
        if (template && template.at + TEMPLATE_TTL_MS > now()) return template.url;
        const tilejson = await (await fetchWithTimeout(TILEJSON_URL)).json();
        const url = Array.isArray(tilejson.tiles) ? tilejson.tiles[0] : null;
        if (typeof url !== 'string' || !url.startsWith('https://')) throw Object.assign(new Error('OpenFreeMap TileJSON has no tile URL'), { status: 502 });
        template = { url, at: now() };
        return url;
    }

    async function cachedTile({ z, x, y }) {
        const url = (await tileTemplate()).replace('{z}', z).replace('{x}', x).replace('{y}', y);
        const cached = tiles.get(url);
        if (cached && cached.at + TILE_TTL_MS > now()) return cached;
        const parsed = (async () => {
            const buffer = new Uint8Array(await (await fetchWithTimeout(url)).arrayBuffer());
            return new VectorTile(new PbfReader(buffer));
        })();
        if (tiles.size >= TILE_CACHE_MAX) tiles.delete(tiles.keys().next().value);
        const entry = { at: now(), parsed, layers: new Map() };
        tiles.set(url, entry);
        try { await parsed; return entry; } catch (error) { tiles.delete(url); throw error; }
    }

    function decodedLayer(entry, { z, x, y }, name) {
        const cached = entry.layers.get(name);
        if (cached) return cached;
        const decoded = entry.parsed.then(tile => {
            const source = tile.layers[name];
            if (!source) return [];
            const features = [];
            for (let i = 0; i < source.length; i++) {
                const feature = source.feature(i).toGeoJSON(x, y, z);
                feature.properties = { ...feature.properties, layer: name };
                features.push(feature);
            }
            return features;
        });
        entry.layers.set(name, decoded);
        return decoded;
    }

    async function tileFeatures(tile, layerNames) {
        const entry = await cachedTile(tile);
        const layers = await Promise.all(layerNames.map(name => decodedLayer(entry, tile, name)));
        return layers.flat();
    }

    // The named layers' features of every tile covering `bbox`, and how many tiles that took.
    async function features(bbox, layerNames, { zoom = ZOOM } = {}) {
        const covering = tilesForBbox(bbox, zoom);
        const decoded = await Promise.all(covering.map(tile => tileFeatures(tile, layerNames)));
        return { tiles: covering.length, features: decoded.flat() };
    }

    // A known tile must be read once. Deriving its covering set from its geographic bbox can pick
    // four neighbours when a floating-point boundary falls on the wrong side of an integer tile edge.
    async function tile(z, x, y, layerNames) {
        if (!tileBbox(z, x, y)) return null;
        return { tiles: 1, features: await tileFeatures({ z, x, y }, layerNames) };
    }

    return { features, tile };
}
