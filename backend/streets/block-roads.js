// Worldwide, parcel-independent OSM road input for urban blocks. Reuses the cached Overpass
// transport, but keeps its broader road policy separate from frontage and cadastral analysis.
import { createOverpassCellSource } from '../buildings/osm-reference.js';

export const BLOCK_HIGHWAYS = Object.freeze([
    'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified',
    'residential', 'living_street', 'pedestrian', 'service',
    'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link'
]);

export function buildBlockRoadQuery([w, s, e, n]) {
    return `[out:json][timeout:25];way["highway"~"^(${BLOCK_HIGHWAYS.join('|')})$"](${s},${w},${n},${e});out geom;`;
}

export function blockRoadsToGeoJSON(elements, cap = 8000, response = {}) {
    if (response.remark) throw Object.assign(new Error('Overpass returned incomplete road data.'), { status: 502 });
    const features = [];
    let truncated = false;
    for (const way of elements || []) {
        if (way.type !== 'way' || !BLOCK_HIGHWAYS.includes(way.tags?.highway)) continue;
        // Do not connect across missing coordinates: that would invent a road segment.
        if (!Array.isArray(way.geometry) || way.geometry.length < 2
            || way.geometry.some(p => !Number.isFinite(p?.lon) || !Number.isFinite(p?.lat))) continue;
        if (features.length >= cap) { truncated = true; break; }
        features.push({ type: 'Feature', id: `w${way.id}`,
            properties: { osm_id: `w${way.id}`, ...way.tags },
            geometry: { type: 'LineString', coordinates: way.geometry.map(p => [p.lon, p.lat]) } });
    }
    return { type: 'FeatureCollection', features, truncated };
}

const cachedSource = createOverpassCellSource({
    label: 'block roads', buildQuery: buildBlockRoadQuery, convert: blockRoadsToGeoJSON
});

export async function fetchBlockRoads(bbox, options = {}) {
    if (bbox.length !== 4 || !bbox.every(Number.isFinite)
        || bbox[0] < -180 || bbox[2] > 180 || bbox[1] < -90 || bbox[3] > 90
        || bbox[2] <= bbox[0] || bbox[3] <= bbox[1]
        || bbox[2] - bbox[0] > 0.06 || bbox[3] - bbox[1] > 0.06) {
        throw Object.assign(new Error('Zoom in: bbox must be WGS84 and span at most 0.06 degrees.'), { status: 400 });
    }
    const fc = await (options.source || cachedSource)(bbox, options);
    // The converter rejects HTTP-200 runtime timeout remarks before the transport caches them.
    return { ...fc, source: 'overpass', bbox };
}
