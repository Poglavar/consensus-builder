import { createOverpassCellSource, PRIORITY } from '../buildings/osm-reference.js';

const CELL_DEG = 0.05;
const MAX_SPAN_DEG = 0.5;
const QUERY_RESULT_CAP = 200;
const CACHE_QUERIES = 32;
const NEIGHBOURHOOD_PLACES = new Set(['neighbourhood', 'suburb', 'quarter', 'locality']);
const cache = new Map();

function literalRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function qlString(value) {
    return literalRegex(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
function bboxQueryPart([west, south, east, north]) { return `(${south},${west},${north},${east})`; }
function parseAddress(value) {
    const match = /^(\d+[a-zA-Z]?(?:[-/]\d+[a-zA-Z]?)?)\s+(.{2,160})$/.exec(String(value || '').trim());
    return match ? { houseNumber: match[1], street: match[2].trim() } : null;
}
function normalizedRequest({ query, address, intersection }) {
    let normalizedAddress = address ? { street: String(address.street || '').trim(), houseNumber: String(address.houseNumber || '').trim() } : null;
    let normalizedIntersection = intersection ? intersection.map(value => String(value).trim()) : null;
    let normalizedQuery = typeof query === 'string' ? query.trim() : '';
    if (!normalizedAddress && !normalizedIntersection) {
        normalizedAddress = parseAddress(normalizedQuery);
        if (normalizedAddress) normalizedQuery = '';
    }
    if (normalizedAddress) normalizedAddress = { street: normalizedAddress.street.trim(), houseNumber: normalizedAddress.houseNumber.trim() };
    if (normalizedIntersection) normalizedIntersection = normalizedIntersection.map(value => value.trim());
    return { query: normalizedQuery, address: normalizedAddress, intersection: normalizedIntersection };
}
function queryFor(search, bbox) {
    const box = bboxQueryPart(bbox);
    if (search.intersection) {
        const [a, b] = search.intersection.map(qlString);
        return `[out:json][timeout:25];(way["highway"]["name"~"${a}",i]${box};)->.a;(way["highway"]["name"~"${b}",i]${box};)->.b;node(w.a)->.na;node(w.b)->.nb;node.na.nb;out center ${QUERY_RESULT_CAP + 1};`;
    }
    const clauses = [];
    if (search.address) {
        const number = qlString(search.address.houseNumber), street = qlString(search.address.street);
        clauses.push(`nwr["addr:housenumber"="${number}"]["addr:street"~"^${street}$",i]${box};`);
    }
    if (search.query) clauses.push(`nwr["name"~"${qlString(search.query)}",i]${box};`);
    return `[out:json][timeout:25];(${clauses.join('')});out center ${QUERY_RESULT_CAP + 1};`;
}
function candidateKind(tags, search) {
    if (search.intersection) return 'intersection';
    if (tags['addr:housenumber']) return 'address';
    if (NEIGHBOURHOOD_PLACES.has(tags.place)) return 'neighbourhood';
    return 'place';
}
function toFeature(el, search) {
    if (!el || !['node', 'way', 'relation'].includes(el.type) || !Number.isSafeInteger(Number(el.id))) return null;
    const tags = el.tags && typeof el.tags === 'object' ? el.tags : {};
    const lat = el.type === 'node' ? Number(el.lat) : Number(el.center?.lat);
    const lon = el.type === 'node' ? Number(el.lon) : Number(el.center?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const kind = candidateKind(tags, search);
    const title = kind === 'intersection' ? `${search.intersection[0]} & ${search.intersection[1]}` :
        kind === 'address' ? `${tags['addr:housenumber']} ${tags['addr:street'] || tags.name || ''}`.trim() :
            String(tags.name || tags['name:en'] || '').trim();
    if (!title) return null;
    const bounds = el.bounds;
    const bbox = bounds && [Number(bounds.minlon), Number(bounds.minlat), Number(bounds.maxlon), Number(bounds.maxlat)].every(Number.isFinite)
        ? [Number(bounds.minlon), Number(bounds.minlat), Number(bounds.maxlon), Number(bounds.maxlat)] : undefined;
    return { type: 'Feature', id: `${el.type}/${el.id}`, geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: { kind, title, osmId: `${el.type}/${el.id}`, bbox } };
}
function convert(elements, cap, json, search) {
    const limit = Math.min(cap, QUERY_RESULT_CAP), features = [];
    let truncated = elements.length > limit;
    for (const el of elements) {
        const feature = toFeature(el, search);
        if (!feature) continue;
        if (features.length >= limit) { truncated = true; break; }
        features.push(feature);
    }
    return { type: 'FeatureCollection', features, truncated };
}
function sourceFor(search) {
    const key = JSON.stringify(search);
    if (cache.has(key)) {
        const existing = cache.get(key);
        cache.delete(key); cache.set(key, existing);
        return existing;
    }
    const source = createOverpassCellSource({ label: 'places', priority: PRIORITY.other, cellDeg: CELL_DEG,
        maxSpanDeg: MAX_SPAN_DEG, featureCap: QUERY_RESULT_CAP,
        buildQuery: bbox => queryFor(search, bbox),
        convert: (elements, cap, json) => convert(elements, cap, json, search) });
    cache.set(key, source);
    if (cache.size > CACHE_QUERIES) cache.delete(cache.keys().next().value);
    return source;
}
function insideBbox(feature, bbox) {
    const [west, south, east, north] = bbox, [lon, lat] = feature.geometry.coordinates;
    return lon >= west && lon <= east && lat >= south && lat <= north;
}

export async function searchOsmPlaces({ bbox, query, address, intersection, limit = 10, fetchImpl, overpassUrl } = {}) {
    const invalid = Object.assign(new Error('Invalid OSM place search parameters.'), { status: 400 });
    if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite)) throw invalid;
    const [west, south, east, north] = bbox;
    if (west < -180 || east > 180 || south < -90 || north > 90 || east <= west || north <= south || east - west > MAX_SPAN_DEG || north - south > MAX_SPAN_DEG) throw invalid;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw invalid;
    if (address && (typeof address !== 'object' || Array.isArray(address))) throw invalid;
    if (intersection && (!Array.isArray(intersection) || intersection.length !== 2)) throw invalid;
    const normalized = normalizedRequest({ query, address, intersection });
    const selectorCount = Number(Boolean(normalized.query)) + Number(Boolean(normalized.address)) + Number(Boolean(normalized.intersection));
    if (selectorCount !== 1 || (normalized.query && normalized.query.length > 200) ||
        (normalized.address && (!normalized.address.street || normalized.address.street.length > 160 || !normalized.address.houseNumber || normalized.address.houseNumber.length > 20)) ||
        (normalized.intersection && normalized.intersection.some(street => !street || street.length > 160))) throw invalid;
    const sourceSearch = normalized.intersection ? { intersection: normalized.intersection } : { query: normalized.query, address: normalized.address };
    const fetchBbox = sourceFor(sourceSearch);
    const result = await fetchBbox(bbox, { cellDeg: CELL_DEG, maxSpanDeg: MAX_SPAN_DEG, fetchImpl, overpassUrl });
    const eligible = result.features.filter(feature => insideBbox(feature, bbox));
    const ranked = eligible.sort((a, b) => {
        const aExact = a.properties.title.toLocaleLowerCase() === (normalized.query || '').toLocaleLowerCase() ? 0 : 1;
        const bExact = b.properties.title.toLocaleLowerCase() === (normalized.query || '').toLocaleLowerCase() ? 0 : 1;
        return aExact - bExact || a.properties.title.localeCompare(b.properties.title) || a.id.localeCompare(b.id);
    });
    const candidates = ranked.slice(0, limit).map(feature => ({ kind: feature.properties.kind, title: feature.properties.title,
        point: feature.geometry.coordinates, ...(feature.properties.bbox ? { bbox: feature.properties.bbox } : {}), osmId: feature.properties.osmId }));
    return { candidates, partial: result.partial === true, truncated: result.truncated === true || ranked.length > limit, source: 'osm-overpass' };
}

export const __osmPlacesInternals = { queryFor, normalizedRequest, parseAddress, literalRegex };
