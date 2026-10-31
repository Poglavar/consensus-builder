// Trees from OpenStreetMap live, for an area the shared `osm_decor` cache does not cover (or when it
// cannot be read): mapped `natural=tree` nodes and the tree-bearing green areas trees are planted
// through, fetched through the shared Overpass cell source (osm-reference.js: our paid instance
// first, then the public server; per-cell cache, throttle and cool-off). The features carry the same
// green-area types as the cache's greenery rows (`payload.t`), so overture-trees.js plants both
// through one query and the same ground yields the same trees from either source.
import { createOverpassCellSource } from '../buildings/osm-reference.js';

// Green-area types trees are planted through, as the greenery bake classifies them
// (zagreb-isochrone scripts/build-tram-greenery-osm.mjs). Water, car parks, pitches, paving and
// sand are greenery rows too, and get no trees.
export const TREE_BEARING_GREENERY = Object.freeze(['forest', 'park', 'cemetery', 'meadow', 'grass']);

const TREES_FEATURE_CAP = 20000;
export const TREES_MAX_SPAN_DEG = 0.06;

const AREA_FILTERS = [
    '["landuse"~"^(forest|meadow|grass|village_green|recreation_ground|cemetery)$"]',
    '["natural"~"^(wood|scrub|heath|grassland)$"]',
    '["leisure"~"^(park|garden)$"]',
    '["amenity"="grave_yard"]'
];

export function buildTreesQuery(bbox) {
    const [w, s, e, n] = bbox;
    const box = `(${s},${w},${n},${e})`;
    const areas = AREA_FILTERS.flatMap(filter => [`way${filter}${box};`, `relation["type"="multipolygon"]${filter}${box};`]);
    return `[out:json][timeout:25];(node["natural"="tree"]${box};${areas.join('')});out geom;`;
}

// The greenery bake's class for an area's tags, limited to the tree-bearing ones (null otherwise).
export function greeneryType(tags = {}) {
    const { landuse = '', natural = '', leisure = '', amenity = '' } = tags;
    if (leisure === 'park' || leisure === 'garden' || landuse === 'village_green' || landuse === 'recreation_ground') return 'park';
    if (landuse === 'cemetery' || amenity === 'grave_yard') return 'cemetery';
    if (landuse === 'forest' || natural === 'wood') return 'forest';
    if (landuse === 'meadow' || natural === 'scrub' || natural === 'heath') return 'meadow';
    if (landuse === 'grass' || natural === 'grassland') return 'grass';
    return null;
}

function ringOf(points) {
    const ring = (Array.isArray(points) ? points : [])
        .filter(p => p && Number.isFinite(p.lon) && Number.isFinite(p.lat))
        .map(p => [p.lon, p.lat]);
    if (ring.length < 4) return null;
    const [first, last] = [ring[0], ring[ring.length - 1]];
    return first[0] === last[0] && first[1] === last[1] ? ring : null;
}

// Overpass `out geom` elements → { features, truncated }: Point features for mapped trees, Polygon
// features ({ properties: { t } }) for green areas. A multipolygon's closed outer ways are its
// polygons; outer rings split over several ways are skipped, holes are ignored.
export function overpassTreesToFeatures(elements, cap = TREES_FEATURE_CAP) {
    const features = [];
    let truncated = false;
    const push = feature => {
        if (features.length >= cap) { truncated = true; return false; }
        features.push(feature);
        return true;
    };
    for (const el of (Array.isArray(elements) ? elements : [])) {
        if (!el || !el.tags) continue;
        if (el.type === 'node') {
            if (el.tags.natural !== 'tree' || !Number.isFinite(el.lon) || !Number.isFinite(el.lat)) continue;
            if (!push({ type: 'Feature', id: `n${el.id}`, geometry: { type: 'Point', coordinates: [el.lon, el.lat] }, properties: { kind: 'trees' } })) break;
            continue;
        }
        const t = greeneryType(el.tags);
        if (!t) continue;
        const rings = el.type === 'way'
            ? [ringOf(el.geometry)]
            : (el.members || []).filter(m => m.type === 'way' && m.role === 'outer').map(m => ringOf(m.geometry));
        let index = 0;
        for (const ring of rings) {
            if (!ring) continue;
            const id = el.type === 'way' ? `w${el.id}` : `r${el.id}-${index++}`;
            if (!push({ type: 'Feature', id, geometry: { type: 'Polygon', coordinates: [ring] }, properties: { kind: 'greenery', t } })) break;
        }
        if (truncated) break;
    }
    return { type: 'FeatureCollection', features, truncated };
}

export const fetchOverpassTrees = createOverpassCellSource({
    label: 'trees',
    buildQuery: buildTreesQuery,
    convert: overpassTreesToFeatures,
    featureCap: TREES_FEATURE_CAP
});
