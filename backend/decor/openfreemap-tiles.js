// OpenFreeMap's vector tiles (OpenStreetMap data in the OpenMapTiles schema, free, no key), read for
// the 3D scene's scenery: which z14 tiles cover a scene, and one cached reader shared by every layer
// read from them (water, green areas), so a tile is fetched and decoded once per scene.

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

export function createTileReader({ fetchImpl = fetch, now = Date.now } = {}) {
    let template = null;
    const tiles = new Map(); // tile URL → { at, layers: { name: GeoJSON features } }

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

    // One tile, every layer decoded to GeoJSON (each feature's `layer` added to its properties) and
    // cached by tile address. In-flight reads are shared, so water and green asking at once fetch once.
    async function decodedTile({ z, x, y }) {
        const url = (await tileTemplate()).replace('{z}', z).replace('{x}', x).replace('{y}', y);
        const cached = tiles.get(url);
        if (cached && cached.at + TILE_TTL_MS > now()) return cached.layers;
        const layers = (async () => {
            const buffer = new Uint8Array(await (await fetchWithTimeout(url)).arrayBuffer());
            const tile = new VectorTile(new PbfReader(buffer));
            const out = {};
            for (const name of Object.keys(tile.layers)) {
                const source = tile.layers[name];
                out[name] = [];
                for (let i = 0; i < source.length; i++) {
                    const feature = source.feature(i).toGeoJSON(x, y, z);
                    feature.properties = { ...feature.properties, layer: name };
                    out[name].push(feature);
                }
            }
            return out;
        })();
        if (tiles.size >= TILE_CACHE_MAX) tiles.delete(tiles.keys().next().value);
        tiles.set(url, { at: now(), layers });
        try { return await layers; } catch (error) { tiles.delete(url); throw error; }
    }

    // The named layers' features of every tile covering `bbox`, and how many tiles that took.
    async function features(bbox, layerNames) {
        const covering = tilesForBbox(bbox);
        const decoded = await Promise.all(covering.map(decodedTile));
        return { tiles: covering.length, features: decoded.flatMap(layers => layerNames.flatMap(name => layers[name] || [])) };
    }

    return { features };
}
