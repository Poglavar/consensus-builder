// Worldwide OSM block boundaries: all highways, railways, waterways and shores. The shared
// model applies ground-level and water-surface rules independently of cadastral classification.
import { createOverpassCellSource, PRIORITY } from '../buildings/osm-reference.js';

export function buildBlockRoadQuery([w, s, e, n]) {
    const box = `(${s},${w},${n},${e})`;
    return `[out:json][timeout:25];(way["highway"]${box};way["railway"]${box};way["waterway"]${box};way["natural"~"^(coastline|water)$"]${box};);out geom;`;
}

export function blockRoadsToGeoJSON(elements, cap = 8000, response = {}) {
    if (response.remark) throw Object.assign(new Error('Overpass returned incomplete boundary data.'), { status: 502 });
    const features = [];
    const seen = new Set();
    let truncated = false;
    for (const way of elements || []) {
        const tags = way?.tags;
        const boundaryWay = tags && (tags.highway !== undefined || tags.railway !== undefined || tags.waterway !== undefined
            || tags.natural === 'coastline' || tags.natural === 'water');
        const id = String(way?.id ?? '');
        if (way?.type !== 'way' || !boundaryWay || !/^[1-9]\d*$/.test(id) || seen.has(id)) continue;
        // Do not connect across missing coordinates: that would invent a boundary segment.
        if (!Array.isArray(way.geometry) || way.geometry.length < 2
            || way.geometry.some(p => !Number.isFinite(p?.lon) || !Number.isFinite(p?.lat))) { throw Object.assign(new Error('Overpass returned incomplete boundary geometry.'), { status: 502 }); }
        if (features.length >= cap) { truncated = true; break; }
        seen.add(id);
        features.push({ type: 'Feature', id: `w${id}`,
            properties: { ...tags, osm_id: `w${id}` },
            geometry: { type: 'LineString', coordinates: way.geometry.map(p => [p.lon, p.lat]) } });
    }
    return { type: 'FeatureCollection', features, truncated };
}

const cachedSource = createOverpassCellSource({
    label: 'block roads', buildQuery: buildBlockRoadQuery, convert: blockRoadsToGeoJSON, priority: PRIORITY.roads
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
    return { ...fc, complete: !fc.partial && !fc.truncated, source: 'overpass', bbox };
}
