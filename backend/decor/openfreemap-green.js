// Green areas around a 3D scene — lawns and parks, meadows and farmland, woods — from OpenFreeMap's
// `landcover` layer, anywhere on Earth, so the model view draws real parks as grass instead of the
// grey pavement under everything else. Each piece is clipped to the scene and given one of three
// looks the renderer's grass pattern knows (three-grass.js): lawn, meadow, forest.

import * as turf from '@turf/turf';
import { expandBbox } from '../buildings/osm-3d.js';
import { createTileReader } from './openfreemap-tiles.js';

// landcover class/subclass → look. Grass subclasses that are mown or tended read as lawn, rough ones
// as meadow; farmland is meadow too; every wood is forest. Anything else (sand, rock, ice, wetland)
// is not drawn.
const MEADOW_GRASS = new Set(['meadow', 'heath', 'scrub', 'grassland', 'fell']);
export function greenLook(props) {
    if (props.class === 'wood') return 'forest';
    if (props.class === 'farmland') return 'meadow';
    if (props.class === 'grass') return MEADOW_GRASS.has(props.subclass) ? 'meadow' : 'lawn';
    return null;
}

// Decoded `landcover` features → [{ geometry, kind }] clipped to `bbox`, polygons only.
export function greenFromTileFeatures(features, bbox) {
    const areas = [];
    for (const feature of features) {
        const kind = greenLook(feature.properties || {});
        if (!kind || !/Polygon$/.test(feature.geometry?.type || '')) continue;
        const piece = turf.bboxClip(feature, bbox);
        const geometry = piece.geometry?.type === 'MultiPolygon'
            ? { type: 'MultiPolygon', coordinates: piece.geometry.coordinates.filter(poly => poly.length && poly[0].length >= 4) }
            : piece.geometry;
        if (!geometry) continue;
        if (geometry.type === 'MultiPolygon' && !geometry.coordinates.length) continue;
        if (geometry.type === 'Polygon' && (!geometry.coordinates[0] || geometry.coordinates[0].length < 4)) continue;
        areas.push({ geometry, kind });
    }
    return areas;
}

const log = (...args) => console.log(`[${new Date().toISOString()}] [green]`, ...args);

export function createGreenProvider({ reader = createTileReader(), now = Date.now } = {}) {
    async function near(geometry, bufferMeters) {
        const bbox = expandBbox(turf.bbox(geometry), bufferMeters);
        const started = now();
        const { tiles, features } = await reader.features(bbox, ['landcover']);
        const areas = greenFromTileFeatures(features, bbox);
        log(`${areas.length} green pieces from ${tiles} tile(s) in ${now() - started} ms`);
        return { areas, count: areas.length, source: 'openfreemap' };
    }
    return { near };
}
