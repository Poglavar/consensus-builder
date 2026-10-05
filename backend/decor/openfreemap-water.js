// Water around a 3D scene — sea, lakes, river surfaces, and the lines of rivers, canals and streams —
// read from OpenFreeMap's vector tiles: OpenStreetMap data in the OpenMapTiles schema, served free
// from a CDN with no key. Tiles rather than Overpass because they carry finished water polygons, the
// sea included (OpenStreetMap itself maps only coastlines), and spend no Overpass credits.

import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import * as turf from '@turf/turf';
import { expandBbox } from '../buildings/osm-3d.js';

const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
// The tile address carries the weekly build, so it is looked up again once a day.
const TEMPLATE_TTL_MS = 24 * 60 * 60 * 1000;
// z14 is the deepest zoom OpenFreeMap serves; one tile is ~2.4 km across at the equator, so a scene
// needs one to four.
const ZOOM = 14;
const TILE_TTL_MS = 6 * 60 * 60 * 1000;
const TILE_CACHE_MAX = 300;
const FETCH_TIMEOUT_MS = 15000;
// Waterway lines carry no width in this schema; a typical one per class, in metres.
const LINE_WIDTH_M = { river: 12, canal: 8, stream: 3, drain: 1.5, ditch: 1.5 };
const DEFAULT_LINE_WIDTH_M = 2;

const log = (...args) => console.log(`[${new Date().toISOString()}] [water]`, ...args);

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

// Decoded tile features (GeoJSON, with `layer` added to properties) → the water to draw inside
// `bbox`, every piece a polygon: areas as mapped, lines widened by their class. Tunnels and culverts
// are underground and left out.
export function waterFromTileFeatures(features, bbox) {
    const areas = [];
    for (const feature of features) {
        const props = feature.properties || {};
        if (props.brunnel === 'tunnel') continue;
        let piece = null;
        if (props.layer === 'water' && /Polygon$/.test(feature.geometry?.type || '')) {
            piece = turf.bboxClip(feature, bbox);
        } else if (props.layer === 'waterway' && /LineString$/.test(feature.geometry?.type || '')) {
            const clipped = turf.bboxClip(feature, bbox);
            if (!clipped.geometry.coordinates.length) continue;
            const width = LINE_WIDTH_M[props.class] ?? DEFAULT_LINE_WIDTH_M;
            piece = turf.buffer(clipped, width / 2, { units: 'meters', steps: 4 });
        }
        if (!piece || !piece.geometry || !piece.geometry.coordinates.length) continue;
        // bboxClip can leave empty rings of a multipolygon; drop them so the renderer gets real shapes.
        const geometry = piece.geometry.type === 'MultiPolygon'
            ? { type: 'MultiPolygon', coordinates: piece.geometry.coordinates.filter(poly => poly.length && poly[0].length >= 4) }
            : piece.geometry;
        if (geometry.type === 'MultiPolygon' && !geometry.coordinates.length) continue;
        if (geometry.type === 'Polygon' && (!geometry.coordinates[0] || geometry.coordinates[0].length < 4)) continue;
        areas.push({ geometry, kind: props.layer === 'water' ? (props.class || 'water') : 'waterway' });
    }
    return areas;
}

export function createWaterProvider({ fetchImpl = fetch, now = Date.now } = {}) {
    let template = null;
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

    // One tile's water and waterway features as GeoJSON, cached by tile address.
    async function tileFeatures({ z, x, y }) {
        const url = (await tileTemplate()).replace('{z}', z).replace('{x}', x).replace('{y}', y);
        const cached = tiles.get(url);
        if (cached && cached.at + TILE_TTL_MS > now()) return cached.features;
        const buffer = new Uint8Array(await (await fetchWithTimeout(url)).arrayBuffer());
        const tile = new VectorTile(new PbfReader(buffer));
        const features = [];
        for (const layer of ['water', 'waterway']) {
            const source = tile.layers[layer];
            if (!source) continue;
            for (let i = 0; i < source.length; i++) {
                const feature = source.feature(i).toGeoJSON(x, y, z);
                feature.properties = { ...feature.properties, layer };
                features.push(feature);
            }
        }
        if (tiles.size >= TILE_CACHE_MAX) tiles.delete(tiles.keys().next().value);
        tiles.set(url, { at: now(), features });
        return features;
    }

    async function near(geometry, bufferMeters) {
        const bbox = expandBbox(turf.bbox(geometry), bufferMeters);
        const started = now();
        const perTile = await Promise.all(tilesForBbox(bbox).map(tileFeatures));
        const areas = waterFromTileFeatures(perTile.flat(), bbox);
        log(`${areas.length} water pieces from ${perTile.length} tile(s) in ${now() - started} ms`);
        return { areas, count: areas.length, source: 'openfreemap' };
    }

    return { near };
}
