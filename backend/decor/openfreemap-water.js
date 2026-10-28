// Water around a 3D scene — sea, lakes, river surfaces, and the lines of rivers, canals and streams —
// read from OpenFreeMap's vector tiles: OpenStreetMap data in the OpenMapTiles schema, served free
// from a CDN with no key. Tiles rather than Overpass because they carry finished water polygons, the
// sea included (OpenStreetMap itself maps only coastlines), and spend no Overpass credits.

import * as turf from '@turf/turf';
import { expandBbox } from '../buildings/osm-3d.js';
import { createTileReader, tilesForBbox } from './openfreemap-tiles.js';

export { tilesForBbox };

// Waterway lines carry no width in this schema; a typical one per class, in metres.
const LINE_WIDTH_M = { river: 12, canal: 8, stream: 3, drain: 1.5, ditch: 1.5 };
const DEFAULT_LINE_WIDTH_M = 2;

const log = (...args) => console.log(`[${new Date().toISOString()}] [water]`, ...args);

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

export function createWaterProvider({ reader = createTileReader(), now = Date.now } = {}) {
    async function near(geometry, bufferMeters) {
        const bbox = expandBbox(turf.bbox(geometry), bufferMeters);
        const started = now();
        const { tiles, features } = await reader.features(bbox, ['water', 'waterway']);
        const areas = waterFromTileFeatures(features, bbox);
        log(`${areas.length} water pieces from ${tiles} tile(s) in ${now() - started} ms`);
        return { areas, count: areas.length, source: 'openfreemap' };
    }

    return { near };
}
