// Water around a 3D scene — sea, lakes, river surfaces, and the lines of rivers, canals and streams —
// read from OpenFreeMap's vector tiles: OpenStreetMap data in the OpenMapTiles schema, served free
// from a CDN with no key. Tiles rather than Overpass because they carry finished water polygons, the
// sea included (OpenStreetMap itself maps only coastlines), and spend no Overpass credits.

import * as turf from '@turf/turf';
import { expandBbox } from '../buildings/osm-3d.js';
import { createTileReader, tileBbox, tilesForBbox } from './openfreemap-tiles.js';

export { tilesForBbox };

// Waterway lines carry no width in this schema; a typical one per class, in metres.
const LINE_WIDTH_M = { river: 12, canal: 8, stream: 3, drain: 1.5, ditch: 1.5 };
const DEFAULT_LINE_WIDTH_M = 2;
const DISPLAY_TILE_PIXELS = 512;
const EARTH_CIRCUMFERENCE_M = 2 * Math.PI * 6371008.8;

const log = (...args) => console.log(`[${new Date().toISOString()}] [water]`, ...args);

// Decoded tile features (GeoJSON, with `layer` added to properties) → the water to draw inside
// `bbox`, every piece a polygon: areas as mapped, lines widened by their class. Tunnels and culverts
// are underground and left out.
export function waterFromTileFeatures(features, bbox, { minimumRiverWidthM = 0 } = {}) {
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
            const sourceWidth = LINE_WIDTH_M[props.class] ?? DEFAULT_LINE_WIDTH_M;
            // A regional overview must retain named rivers after their source width falls beneath
            // a display pixel. Canals, streams, drains and ditches retain their mapped widths.
            const width = props.class === 'river' ? Math.max(sourceWidth, minimumRiverWidthM) : sourceWidth;
            piece = turf.buffer(clipped, width / 2, { units: 'meters', steps: 4 });
        }
        if (!piece || !piece.geometry || !piece.geometry.coordinates.length) continue;
        // Buffering a line expands it outside the source tile. Clip again so neighbouring regional
        // tiles meet on their shared edge without drawing each other's river surface.
        piece = turf.bboxClip(piece, bbox);
        if (!piece.geometry || !piece.geometry.coordinates.length) continue;
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

export function createWaterProvider({ reader = createTileReader(), now = Date.now } = {}) {
    async function near(geometry, bufferMeters) {
        const bbox = expandBbox(turf.bbox(geometry), bufferMeters);
        const started = now();
        const { tiles, features } = await reader.features(bbox, ['water', 'waterway']);
        const areas = waterFromTileFeatures(features, bbox);
        log(`${areas.length} water pieces from ${tiles} tile(s) in ${now() - started} ms`);
        return { areas, count: areas.length, source: 'openfreemap' };
    }

    // A regional water tile is supplied at the native OpenFreeMap zoom requested by the renderer.
    // Lakes and coasts arrive generalized by the source. A river gets at least 0.9 of the 512 px
    // display tile at z0..11, corrected for latitude, so it stays legible at regional distance.
    async function tile(z, x, y) {
        const bbox = tileBbox(z, x, y);
        if (!bbox) return null;
        const started = now();
        const source = await reader.tile(z, x, y, ['water', 'waterway']);
        const { tiles, features } = source || { tiles: 0, features: [] };
        const latitude = (bbox[1] + bbox[3]) / 2;
        const metresPerDisplayPixel = EARTH_CIRCUMFERENCE_M * Math.cos(latitude * Math.PI / 180) / (DISPLAY_TILE_PIXELS * 2 ** z);
        const minimumRiverWidthM = z <= 11 ? metresPerDisplayPixel * 0.9 : 0;
        const areas = waterFromTileFeatures(features, bbox, { minimumRiverWidthM });
        log(`${areas.length} overview water pieces from ${tiles} tile(s) at z${z} in ${now() - started} ms`);
        return { areas, count: areas.length, source: 'openfreemap', z, x, y, bbox };
    }

    return { near, tile };
}
