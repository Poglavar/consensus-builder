import { createOverpassCellSource, PRIORITY } from '../buildings/osm-reference.js';

const CELL_DEG = 0.005;
const MAX_QUERY_SPAN_DEG = 0.03;
const MAX_FEATURES = 100;
const MAX_COORDINATES = 10_000;
const CACHE_SOURCES = 32;
const sources = new Map();
const fail = (code, status, message) => Object.assign(new Error(message), { code, status });

function idParts(osmId) {
    const match = /^(node|way|relation)\/([1-9]\d{0,17})$/.exec(String(osmId || ''));
    if (!match) throw fail('invalid-landmark-id', 400, 'OSM id must be node/<id>, way/<id> or relation/<id>.');
    return { type: match[1], id: match[2] };
}
function qlString(value) { return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
function pointOf(value) {
    if (!Array.isArray(value) || value.length !== 2 || !value.every(Number.isFinite) || value[0] < -180 || value[0] > 180 || value[1] < -90 || value[1] > 90) {
        throw fail('invalid-landmark-point', 400, 'Point must be longitude,latitude in WGS84.');
    }
    return value;
}
function gridBox(bbox) {
    const round = value => Math.round(value * 1e6) / 1e6;
    const floor = value => round(Math.floor(value / CELL_DEG) * CELL_DEG);
    const ceil = value => round(Math.ceil(value / CELL_DEG) * CELL_DEG);
    const snapped = [floor(bbox[0]), floor(bbox[1]), ceil(bbox[2]), ceil(bbox[3])];
    if (snapped[2] <= snapped[0]) snapped[2] = round(snapped[0] + CELL_DEG);
    if (snapped[3] <= snapped[1]) snapped[3] = round(snapped[1] + CELL_DEG);
    if (snapped[0] < -180 || snapped[2] > 180 || snapped[1] < -90 || snapped[3] > 90 ||
        snapped[2] - snapped[0] > MAX_QUERY_SPAN_DEG || snapped[3] - snapped[1] > MAX_QUERY_SPAN_DEG) {
        throw fail('landmark-area-too-large', 400, 'The landmark search area exceeds the bounded Overpass query size.');
    }
    return snapped;
}
function pointCell([lon, lat]) {
    const round = value => Math.round(value * 1e6) / 1e6;
    const west = Math.min(180 - CELL_DEG, Math.max(-180, Math.floor(lon / CELL_DEG) * CELL_DEG));
    const south = Math.min(90 - CELL_DEG, Math.max(-90, Math.floor(lat / CELL_DEG) * CELL_DEG));
    return [round(west), round(south), round(west + CELL_DEG), round(south + CELL_DEG)];
}
function bboxOfGeometry(geometry) {
    const bounds = [Infinity, Infinity, -Infinity, -Infinity];
    let count = 0;
    const walk = coords => {
        if (!Array.isArray(coords)) throw fail('landmark-incomplete', 503, 'OSM geometry is incomplete.');
        if (typeof coords[0] === 'number') {
            const [lon, lat] = coords;
            if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) throw fail('landmark-incomplete', 503, 'OSM geometry contains invalid coordinates.');
            count++;
            if (count > MAX_COORDINATES) throw fail('landmark-too-large', 503, 'OSM geometry exceeds the coordinate limit.');
            bounds[0] = Math.min(bounds[0], lon); bounds[1] = Math.min(bounds[1], lat);
            bounds[2] = Math.max(bounds[2], lon); bounds[3] = Math.max(bounds[3], lat);
            return;
        }
        for (const child of coords) walk(child);
    };
    walk(geometry?.coordinates);
    if (!count || !bounds.every(Number.isFinite)) throw fail('landmark-incomplete', 503, 'OSM geometry is incomplete.');
    return bounds;
}
function coordinateCount(geometry) {
    let count = 0;
    const walk = coords => {
        if (!Array.isArray(coords)) throw fail('landmark-incomplete', 503, 'OSM geometry is incomplete.');
        if (typeof coords[0] === 'number') { count++; return; }
        for (const child of coords) walk(child);
    };
    walk(geometry?.coordinates);
    return count;
}
function coordinatesOf(geometry) {
    if (!Array.isArray(geometry) || geometry.length < 2) throw fail('landmark-incomplete', 503, 'OSM way geometry is incomplete.');
    const coords = geometry.map(point => {
        if (!point || !Number.isFinite(point.lon) || !Number.isFinite(point.lat) || point.lon < -180 || point.lon > 180 || point.lat < -90 || point.lat > 90) {
            throw fail('landmark-incomplete', 503, 'OSM way geometry contains invalid coordinates.');
        }
        return [point.lon, point.lat];
    });
    if (coords.length > MAX_COORDINATES) throw fail('landmark-too-large', 503, 'OSM geometry exceeds the coordinate limit.');
    return coords;
}
function samePoint(a, b) { return a[0] === b[0] && a[1] === b[1]; }
function closed(ring) { return ring.length >= 4 && samePoint(ring[0], ring.at(-1)); }
function isArea(tags, coords) {
    if (tags.area === 'no') return false;
    if (tags.area === 'yes' && !closed(coords)) throw fail('landmark-incomplete', 503, 'OSM area geometry is not closed.');
    if (tags.building !== undefined && !closed(coords)) throw fail('landmark-incomplete', 503, 'OSM building geometry is not closed.');
    if (!closed(coords)) return false;
    const area = tags.area === 'yes' || tags.man_made === 'bridge' || (tags.bridge === 'yes' && !tags.highway) || tags.building !== undefined ||
        tags.landuse !== undefined || tags.leisure !== undefined || tags.natural !== undefined || tags.amenity !== undefined;
    if (!area) return false;
    if (new Set(coords.slice(0, -1).map(point => `${point[0]},${point[1]}`)).size < 3) throw fail('landmark-incomplete', 503, 'OSM area geometry is degenerate.');
    return true;
}
function categoryOf(tags) {
    if (tags.man_made === 'bridge' || tags.bridge === 'yes') return 'bridge';
    if (tags.railway === 'station' || tags.public_transport === 'station') return 'station';
    if (tags.railway === 'subway_entrance' || (tags.entrance && tags.entrance !== 'no')) return 'entrance';
    if (tags.railway === 'platform' || tags.public_transport === 'platform') return 'platform';
    if (tags.public_transport === 'stop_position' || tags.highway === 'bus_stop' || ['tram_stop', 'bus_stop'].includes(tags.railway)) return 'stop';
    if (['neighbourhood', 'suburb', 'quarter', 'locality'].includes(tags.place)) return 'neighbourhood';
    return null;
}
function feature(element, geometry, { id = element.id, type = element.type, tags = element.tags || {}, parentOsmId } = {}) {
    const osmId = `${type}/${id}`;
    return { type: 'Feature', id: osmId, geometry, properties: {
        osmId, name: tags.name || tags['name:en'] || null, category: categoryOf(tags),
        man_made: tags.man_made || null, bridge: tags.bridge || null, highway: tags.highway || null,
        railway: tags.railway || null, type: tags.type || type, ...(parentOsmId ? { parentOsmId } : {})
    } };
}
function pointInRing(point, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        const crosses = ((yi > point[1]) !== (yj > point[1])) && point[0] < (xj - xi) * (point[1] - yi) / ((yj - yi) || Number.EPSILON) + xi;
        if (crosses) inside = !inside;
    }
    return inside;
}
function areaOfRing(ring) {
    let area = 0;
    for (let i = 0; i < ring.length - 1; i++) area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    return Math.abs(area / 2);
}
function stitchRole(members, role) {
    const segments = members.filter(member => member?.type === 'way' && (member.role || 'outer') === role)
        .map(member => coordinatesOf(member.geometry));
    if (!segments.length) return [];
    const rings = [];
    while (segments.length) {
        let ring = segments.shift();
        while (!closed(ring)) {
            const tail = ring.at(-1), index = segments.findIndex(segment => samePoint(segment[0], tail) || samePoint(segment.at(-1), tail));
            if (index < 0) throw fail('landmark-incomplete', 503, `OSM multipolygon ${role} ring is not closed.`);
            let next = segments.splice(index, 1)[0];
            if (samePoint(next.at(-1), tail)) next = next.slice().reverse();
            ring = ring.concat(next.slice(1));
            if (ring.length > MAX_COORDINATES) throw fail('landmark-too-large', 503, 'OSM geometry exceeds the coordinate limit.');
        }
        if (new Set(ring.slice(0, -1).map(point => `${point[0]},${point[1]}`)).size < 3) throw fail('landmark-incomplete', 503, 'OSM multipolygon has a degenerate ring.');
        rings.push(ring);
    }
    return rings;
}
function convertElement(element) {
    if (!element || !['node', 'way', 'relation'].includes(element.type) || !/^[1-9]\d{0,17}$/.test(String(element.id)) || !element.tags || typeof element.tags !== 'object') {
        throw fail('landmark-incomplete', 503, 'OSM returned an invalid landmark element.');
    }
    if (element.type === 'node') {
        if (!Number.isFinite(element.lon) || !Number.isFinite(element.lat)) throw fail('landmark-incomplete', 503, 'OSM landmark point is incomplete.');
        return [feature(element, { type: 'Point', coordinates: [element.lon, element.lat] })];
    }
    if (element.type === 'way') {
        const coords = coordinatesOf(element.geometry);
        return [feature(element, isArea(element.tags, coords) ? { type: 'Polygon', coordinates: [coords] } : { type: 'LineString', coordinates: coords })];
    }
    const members = Array.isArray(element.members) ? element.members : [];
    if (element.tags.type === 'multipolygon') {
        if (members.some(member => member?.type === 'way' && !['', 'outer', 'inner'].includes(member.role || ''))) {
            throw fail('landmark-incomplete', 503, 'OSM multipolygon has an unsupported way member role.');
        }
        const outer = stitchRole(members, 'outer'), inner = stitchRole(members, 'inner');
        if (!outer.length) throw fail('landmark-incomplete', 503, 'OSM multipolygon has no complete outer ring.');
        const polygons = outer.map(ring => [ring]);
        for (const hole of inner) {
            const index = polygons.map((polygon, i) => ({ i, area: areaOfRing(polygon[0]) }))
                .filter(row => pointInRing(hole[0], polygons[row.i][0])).sort((a, b) => a.area - b.area)[0]?.i;
            if (index === undefined) throw fail('landmark-incomplete', 503, 'OSM multipolygon has an inner ring outside every outer ring.');
            polygons[index].push(hole);
        }
        const geometry = polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0] } : { type: 'MultiPolygon', coordinates: polygons };
        bboxOfGeometry(geometry);
        return [feature(element, geometry)];
    }
    const ways = members.filter(member => member?.type === 'way');
    if (!ways.length) throw fail('landmark-incomplete', 503, 'OSM relation has no complete way geometry.');
    const lines = ways.map(member => coordinatesOf(member.geometry));
    const result = feature(element, { type: 'MultiLineString', coordinates: lines });
    result.properties.memberOsmIds = ways.map(member => `way/${member.ref}`);
    bboxOfGeometry(result.geometry);
    return [result];
}
function convertElements(elements, cap, _json, expectedId = null) {
    if (!Array.isArray(elements)) throw fail('landmark-incomplete', 503, 'OSM landmark response is incomplete.');
    if (expectedId && elements.length > 1) throw fail('landmark-incomplete', 503, 'OSM id lookup returned more than one element.');
    const features = [];
    let totalCoordinates = 0, truncated = elements.length > cap || elements.length > MAX_FEATURES;
    for (const element of elements.slice(0, cap)) {
        for (const item of convertElement(element)) {
            totalCoordinates += coordinateCount(item.geometry);
            if (totalCoordinates > MAX_COORDINATES) throw fail('landmark-too-large', 503, 'OSM geometry exceeds the coordinate limit.');
            features.push(item);
        }
    }
    if (features.length > MAX_FEATURES) truncated = true;
    return { type: 'FeatureCollection', features: features.slice(0, MAX_FEATURES), truncated };
}
function sourceFor(key, query, { expectedId = null, featureCap = MAX_FEATURES + 1 } = {}) {
    if (sources.has(key)) {
        const source = sources.get(key); sources.delete(key); sources.set(key, source); return source;
    }
    const source = createOverpassCellSource({ label: 'landmark geometry', priority: PRIORITY.other,
        maxSpanDeg: MAX_QUERY_SPAN_DEG, featureCap,
        buildQuery: bbox => `${query(bbox)}`,
        convert: (elements, cap, json) => convertElements(elements, Math.min(cap, featureCap), json, expectedId) });
    sources.set(key, source);
    if (sources.size > CACHE_SOURCES) sources.delete(sources.keys().next().value);
    return source;
}
function exactIdQuery({ type, id }) { return () => `[out:json][timeout:25];${type}(${id});out geom;`; }
function bridgeQuery(name, queryBbox) {
    const qname = qlString(name);
    return () => {
        const bbox = queryBbox;
        const [west, south, east, north] = bbox, box = `(${south},${west},${north},${east})`;
        return `[out:json][timeout:25];(way["name"="${qname}"]["man_made"="bridge"]${box};way["name"="${qname}"]["bridge"="yes"]${box};relation["name"="${qname}"]["man_made"="bridge"]${box};relation["name"="${qname}"]["bridge"="yes"]${box};);out ${MAX_FEATURES + 1} geom;`;
    };
}
function bufferMeters(bbox, meters = 100) {
    const latPad = meters / 111_320;
    const centerLat = (bbox[1] + bbox[3]) / 2;
    const lonPad = meters / (111_320 * Math.max(0.01, Math.cos(centerLat * Math.PI / 180)));
    const out = [bbox[0] - lonPad, bbox[1] - latPad, bbox[2] + lonPad, bbox[3] + latPad];
    if (out[0] < -180 || out[2] > 180 || out[1] < -90 || out[3] > 90) throw fail('landmark-area-too-large', 400, 'Landmark search area is outside the WGS84 bounds.');
    return out;
}
function assertComplete(result) {
    if (result.partial || result.truncated) throw fail('landmark-incomplete', 503, 'OpenStreetMap returned incomplete landmark geometry.');
}
function assertBoundedSeed(bounds, point) {
    if (bounds[2] - bounds[0] > MAX_QUERY_SPAN_DEG || bounds[3] - bounds[1] > MAX_QUERY_SPAN_DEG) {
        throw fail('landmark-too-large', 503, 'OSM landmark geometry exceeds the maximum 0.03 degree span.');
    }
    const nearby = bufferMeters(bounds, 100);
    if (point[0] < nearby[0] || point[0] > nearby[2] || point[1] < nearby[1] || point[1] > nearby[3]) {
        throw fail('landmark-point-mismatch', 404, 'The OSM landmark is not near the supplied point.');
    }
}
function assertFeatureLimits(features) {
    if (features.length > MAX_FEATURES) throw fail('landmark-too-large', 503, 'OSM landmark geometry exceeds the feature limit.');
    const total = features.reduce((sum, item) => sum + coordinateCount(item.geometry), 0);
    if (total > MAX_COORDINATES) throw fail('landmark-too-large', 503, 'OSM landmark geometry exceeds the coordinate limit.');
}

export async function searchLandmarkGeometry({ osmId, point, fetchImpl, overpassUrl } = {}) {
    const identity = idParts(osmId), anchor = pointOf(point);
    const seedBox = pointCell(anchor);
    const seedSource = sourceFor(`seed:${osmId}`, exactIdQuery(identity), { expectedId: osmId, featureCap: 2 });
    const seedResult = await seedSource(seedBox, { cellDeg: CELL_DEG, maxSpanDeg: MAX_QUERY_SPAN_DEG, fetchImpl, overpassUrl });
    assertComplete(seedResult);
    const seed = seedResult.features.find(item => item.properties.osmId === osmId);
    if (!seed) throw fail('landmark-not-found', 404, 'The selected OSM landmark was not found near the supplied point.');
    const seedBounds = bboxOfGeometry(seed.geometry);
    assertBoundedSeed(seedBounds, anchor);
    const seedTitle = seed.properties.name;
    let features = [seed];
    if (seed.properties.category === 'bridge' && seedTitle) {
        const queryBbox = bufferMeters(seedBounds), nearbyBox = gridBox(queryBbox);
        const nearbySource = sourceFor(`bridge:${seedTitle}:${nearbyBox.join(',')}`, bridgeQuery(seedTitle, queryBbox));
        const nearbyResult = await nearbySource(nearbyBox, { cellDeg: CELL_DEG, maxSpanDeg: MAX_QUERY_SPAN_DEG, fetchImpl, overpassUrl });
        assertComplete(nearbyResult);
        const byId = new Map(features.map(item => [item.properties.osmId, item]));
        for (const item of nearbyResult.features) byId.set(item.properties.osmId, item);
        features = [...byId.values()];
    }
    assertFeatureLimits(features);
    return { osmId, title: seedTitle || osmId, category: seed.properties.category, features, partial: false, truncated: false, source: 'osm-overpass' };
}

export const __landmarkSourceInternals = { idParts, gridBox, pointCell, bboxOfGeometry, coordinatesOf, categoryOf, convertElement, convertElements, bridgeQuery, bufferMeters, stitchRole };
