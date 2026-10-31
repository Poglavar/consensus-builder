// Street furniture from OpenStreetMap live, for the 3D model view: fountains (`amenity=fountain`,
// mapped as a point or as the basin's outline) and street lamps (`highway=street_lamp`), in one
// Overpass query per cell through the shared cell source (osm-reference.js: our paid instance first,
// per-cell cache, the admission gate). The scene draws them with the same fountain and lamp models
// as the ones people place in parks and squares.
import { createOverpassCellSource } from '../buildings/osm-reference.js';
import { bufferedBbox } from './overture-trees.js';

const FURNITURE_FEATURE_CAP = 20000;
export const FURNITURE_MAX_SPAN_DEG = 0.06;
// A fountain mapped as a point gets a basin this wide; an outline gets its own, within limits.
export const DEFAULT_FOUNTAIN_RADIUS_M = 2.5;
const FOUNTAIN_RADIUS_LIMITS_M = [1, 15];

export function buildFurnitureQuery(bbox) {
    const [w, s, e, n] = bbox;
    const box = `(${s},${w},${n},${e})`;
    return `[out:json][timeout:25];(node["amenity"="fountain"]${box};way["amenity"="fountain"]${box};node["highway"="street_lamp"]${box};);out geom;`;
}

// A closed ring's centroid and the radius of a circle of the same area (metres, equirectangular
// about the ring's own latitude: fountains are small).
export function ringCircle(points) {
    const ring = (Array.isArray(points) ? points : []).filter(p => p && Number.isFinite(p.lon) && Number.isFinite(p.lat));
    if (ring.length < 4) return null;
    // Metres from the first vertex: absolute metres would lose the centroid to cancellation.
    const { lon: lon0, lat: lat0 } = ring[0];
    const mx = 111320 * Math.cos(lat0 * Math.PI / 180), my = 110570;
    let area = 0, cx = 0, cy = 0;
    for (let i = 0; i < ring.length - 1; i++) {
        const x0 = (ring[i].lon - lon0) * mx, y0 = (ring[i].lat - lat0) * my;
        const x1 = (ring[i + 1].lon - lon0) * mx, y1 = (ring[i + 1].lat - lat0) * my;
        const cross = x0 * y1 - x1 * y0;
        area += cross;
        cx += (x0 + x1) * cross;
        cy += (y0 + y1) * cross;
    }
    if (Math.abs(area) < 1e-6) return null;
    area /= 2;
    return { lng: lon0 + cx / (6 * area) / mx, lat: lat0 + cy / (6 * area) / my, radiusM: Math.sqrt(Math.abs(area) / Math.PI) };
}

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));

// Overpass `out geom` elements → { features, truncated }: Point features with
// properties { kind: 'fountain', radiusM } or { kind: 'lamp' }.
export function overpassFurnitureToFeatures(elements, cap = FURNITURE_FEATURE_CAP) {
    const features = [];
    let truncated = false;
    for (const el of (Array.isArray(elements) ? elements : [])) {
        if (!el || !el.tags) continue;
        let feature = null;
        if (el.type === 'node' && Number.isFinite(el.lon) && Number.isFinite(el.lat)) {
            if (el.tags.amenity === 'fountain') {
                feature = { id: `n${el.id}`, coordinates: [el.lon, el.lat], properties: { kind: 'fountain', radiusM: DEFAULT_FOUNTAIN_RADIUS_M } };
            } else if (el.tags.highway === 'street_lamp') {
                feature = { id: `n${el.id}`, coordinates: [el.lon, el.lat], properties: { kind: 'lamp' } };
            }
        } else if (el.type === 'way' && el.tags.amenity === 'fountain') {
            const circle = ringCircle(el.geometry);
            if (circle) feature = { id: `w${el.id}`, coordinates: [circle.lng, circle.lat], properties: { kind: 'fountain', radiusM: clamp(circle.radiusM, FOUNTAIN_RADIUS_LIMITS_M) } };
        }
        if (!feature) continue;
        if (features.length >= cap) { truncated = true; break; }
        features.push({ type: 'Feature', id: feature.id, geometry: { type: 'Point', coordinates: feature.coordinates }, properties: feature.properties });
    }
    return { type: 'FeatureCollection', features, truncated };
}

export const fetchOverpassFurniture = createOverpassCellSource({
    label: 'street-furniture',
    buildQuery: buildFurnitureQuery,
    convert: overpassFurnitureToFeatures,
    featureCap: FURNITURE_FEATURE_CAP
});

// near(geometry, bufferMeters) → { fountains: [[lng, lat, radiusM]], lamps: [[lng, lat]], count,
// source, partial? }. A box wider than the live source takes is read around its centre.
export function createStreetFurnitureProvider({ fetchFurniture = fetchOverpassFurniture } = {}) {
    async function near(geometry, bufferMeters) {
        let [w, s, e, n] = bufferedBbox(geometry, bufferMeters);
        const half = FURNITURE_MAX_SPAN_DEG * 0.99 / 2, cx = (w + e) / 2, cy = (s + n) / 2;
        w = Math.max(w, cx - half); e = Math.min(e, cx + half); s = Math.max(s, cy - half); n = Math.min(n, cy + half);
        const osm = await fetchFurniture([w, s, e, n]);
        const fountains = [], lamps = [];
        for (const feature of osm.features) {
            const [lng, lat] = feature.geometry.coordinates;
            if (feature.properties.kind === 'fountain') fountains.push([lng, lat, Math.round(feature.properties.radiusM * 10) / 10]);
            else if (feature.properties.kind === 'lamp') lamps.push([lng, lat]);
        }
        return { fountains, lamps, count: fountains.length + lamps.length, source: 'overpass', ...(osm.partial ? { partial: true } : {}) };
    }
    return { near };
}
