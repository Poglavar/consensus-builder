// One street at a point (or by name in a box), cut into segments (frontend/js/streets/street-segments.js),
// with the house numbers and buildings along it and its official identity where a source has one.
// Ways come from the road network reader (osm_road, else the Overpass chain); buildings from the
// OSM buildings cell source; house numbers from an address cell source on the same chain
// (osm-reference.js: Tracestrack first when its key is set). Official identities are a source
// registry of adapters: OSM's own `ref:GB:usrn` tags (OS USRN) and the street register in geodata.
import { createRequire } from 'node:module';
import { fetchOsmBuildings, createOverpassCellSource, PRIORITY } from '../buildings/osm-reference.js';
import { createRoadNetworkRegistry, NETWORK_ENVIRONMENT_SOURCES } from '../sources/network-environment.js';
const require = createRequire(import.meta.url);
const S = require('../../frontend/js/streets/street-segments.js');
const SourceRuntime = require('../../frontend/js/source-runtime.js');

// The first read around a point: about 1.3 km north–south. A street reaching its edge is read again
// over its own extent, up to MAX_SPAN_DEG (the Overpass chain answers at most 0.06°).
const START_HALF_DEG = 0.006;
const MAX_SPAN_DEG = 0.04;
const EDGE_M = 50;
const MARGIN_DEG = 0.0006;
const ADDRESS_CAP = 8000;
const M_PER_DEG = Math.PI * 6378137 / 180;
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

// ── house numbers ────────────────────────────────────────────────────────────────────────────

export function buildAddressQuery(bbox) {
    const [w, s, e, n] = bbox;
    return `[out:json][timeout:25];nwr["addr:housenumber"](${s},${w},${n},${e});out center;`;
}
// Overpass `out center` elements → Point features { number, street }; a building way or an
// address node alike.
export function overpassAddresses(elements, cap = ADDRESS_CAP) {
    const features = [];
    let truncated = false;
    for (const el of Array.isArray(elements) ? elements : []) {
        const tags = el && el.tags;
        if (!tags || !tags['addr:housenumber']) continue;
        const lon = el.type === 'node' ? el.lon : el.center?.lon, lat = el.type === 'node' ? el.lat : el.center?.lat;
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        if (features.length >= cap) { truncated = true; break; }
        features.push({ type: 'Feature', id: `${el.type[0]}${el.id}`, geometry: { type: 'Point', coordinates: [lon, lat] },
            properties: { number: String(tags['addr:housenumber']).slice(0, 20), street: tags['addr:street'] || tags['addr:place'] || null } });
    }
    return { type: 'FeatureCollection', features, truncated };
}
const fetchOsmAddresses = createOverpassCellSource({ label: 'addresses', buildQuery: buildAddressQuery, convert: overpassAddresses, priority: PRIORITY.other });

// ── official identity ────────────────────────────────────────────────────────────────────────

export const STREET_IDENTITY_SOURCES = Object.freeze([
    // OS Unique Street Reference Numbers that OSM mappers copied onto the ways (England, Wales, Scotland).
    SourceRuntime.source('street-identity', 'osm-tag-ref', { tag: 'ref:GB:usrn', scheme: 'GB-USRN' }, { id: 'osm-gb-usrn', label: 'OS USRN tagged in OpenStreetMap' }),
    // The official street register already in geodata (public.street, matched by name).
    SourceRuntime.source('street-identity', 'postgis-street-register-match', { resource: 'street', scheme: 'HR-street-register' }, { id: 'street-register-match', label: 'Street register (public.street)' })
]);

const EXTENT_TTL_MS = 10 * 60 * 1000;
export function createStreetIdentityRegistry(pool) {
    let extent = null, extentAt = 0;
    async function registerExtent() {
        if (extentAt + EXTENT_TTL_MS > Date.now()) return extent;
        // The planner's estimate in the table's CRS, as WGS84: cheap, and only a coverage guard.
        const { rows } = await pool.query(`
            SELECT ST_XMin(e) AS w, ST_YMin(e) AS s, ST_XMax(e) AS e, ST_YMax(e) AS n FROM (
                SELECT ST_Transform(ST_SetSRID(ST_EstimatedExtent('public', 'street', 'geom')::geometry, 3765), 4326) AS e) x`);
        const row = rows && rows[0];
        extent = row && [row.w, row.s, row.e, row.n].every(v => Number.isFinite(Number(v))) ? [row.w, row.s, row.e, row.n].map(Number) : null;
        extentAt = Date.now();
        return extent;
    }
    const recent = new Map();
    const one = (scheme, ids) => ({ official: ids.length === 1 ? { scheme, id: ids[0] } : null, ids });
    const registry = SourceRuntime.createRegistry({ abstraction: 'street-identity', required: ['identify'], sources: STREET_IDENTITY_SOURCES, adapters: {
        'osm-tag-ref': { custom: false, create: config => ({
            async identify({ ways }) {
                // Every way of the street must carry the same value; a partly tagged street is not identified.
                const values = ways.map(way => way.tags && way.tags[config.tag] ? String(way.tags[config.tag]).split(';').map(v => v.trim()).filter(Boolean) : []);
                const ids = [...new Set(values.flat())].sort();
                return values.some(list => !list.length) ? { official: null, ids } : one(config.scheme, ids);
            }
        }) },
        'postgis-street-register-match': { custom: false, create: config => ({
            async identify({ name, bbox }) {
                // One street's segments ask with the same name and box: answer them from one query.
                const key = `${S.normaliseName(name)}|${bbox.join(',')}`;
                const hit = recent.get(key);
                if (hit && hit.at + 60000 > Date.now()) return hit.answer;
                const answer = await lookup(config.scheme, name, bbox);
                if (recent.size > 200) recent.clear();
                recent.set(key, { at: Date.now(), answer });
                return answer;
            }
        }) }
    } });
    async function lookup(scheme, name, bbox) {
        const covered = await registerExtent();
        if (!covered || bbox[0] < covered[0] || bbox[1] < covered[1] || bbox[2] > covered[2] || bbox[3] > covered[3]) return { official: null, ids: [] };
        const { rows } = await pool.query(`
            SELECT DISTINCT street_id, street_name FROM street
            WHERE current AND geom && ST_Transform(ST_MakeEnvelope($1, $2, $3, $4, 4326), 3765)
            LIMIT 500`, bbox);
        const key = S.normaliseName(name);
        return one(scheme, [...new Set(rows.filter(row => S.normaliseName(row.street_name) === key).map(row => String(row.street_id)))].sort());
    }
    return registry;
}

// ── the street ───────────────────────────────────────────────────────────────────────────────

function boxAround([lng, lat], halfDeg) {
    const dx = halfDeg / Math.max(0.2, Math.cos(lat * Math.PI / 180));
    return [lng - dx, lat - halfDeg, lng + dx, lat + halfDeg];
}
function boundsOf(ways) {
    const all = ways.flatMap(way => way.coords);
    return [Math.min(...all.map(c => c[0])), Math.min(...all.map(c => c[1])), Math.max(...all.map(c => c[0])), Math.max(...all.map(c => c[1]))];
}
const grow = (b, d) => [b[0] - d, b[1] - d, b[2] + d, b[3] + d];
function nearEdge(inner, outer) {
    const lat = (outer[1] + outer[3]) / 2, mx = M_PER_DEG * Math.cos(lat * Math.PI / 180);
    return (inner[0] - outer[0]) * mx < EDGE_M || (outer[2] - inner[2]) * mx < EDGE_M
        || (inner[1] - outer[1]) * M_PER_DEG < EDGE_M || (outer[3] - inner[3]) * M_PER_DEG < EDGE_M;
}
// A box no wider or taller than MAX_SPAN_DEG, keeping `centre` inside.
function capped(b, centre) {
    const clamp = (lo, hi, c) => (hi - lo <= MAX_SPAN_DEG ? [lo, hi] : [Math.max(lo, c - MAX_SPAN_DEG / 2), Math.min(hi, c + MAX_SPAN_DEG / 2)]);
    const [w, e] = clamp(b[0], b[2], centre[0]), [s, n] = clamp(b[1], b[3], centre[1]);
    return [w, s, e, n];
}

export function createStreetSegments(pool, options = {}) {
    const roads = options.roads || createRoadNetworkRegistry(pool, options).open(NETWORK_ENVIRONMENT_SOURCES.roads);
    const fetchBuildings = options.fetchBuildings || fetchOsmBuildings;
    const fetchAddresses = options.fetchAddresses || fetchOsmAddresses;
    const identity = options.identity || createStreetIdentityRegistry(pool);
    const identityReaders = () => identity.sources().map(source => ({ source, reader: identity.open(source.id) }));
    const log = (...args) => console.log(`[${new Date().toISOString()}] [streets/segments]`, ...args);

    async function readWays(bbox) {
        const rows = await roads.readNetwork([bbox], true);
        if (rows.length) return { ways: S.normaliseWays(rows), source: 'osm_road', partial: false };
        const live = await roads.readLiveNetwork(bbox, true);
        return { ways: S.normaliseWays(live.features), source: 'overpass', partial: !!(live.partial || live.truncated) };
    }

    async function officialOf(name, ways, bbox) {
        const found = [];
        for (const { source, reader } of identityReaders()) {
            try {
                const answer = await reader.identify({ name, ways, bbox });
                if (answer.official || answer.ids.length) found.push({ source: source.id, ...answer });
            } catch (error) {
                console.warn(`[${new Date().toISOString()}] [streets/segments] identity source ${source.id} failed: ${error.message}`);
            }
        }
        return { official: found.find(row => row.official)?.official || null, officialIds: found.flatMap(row => row.ids.map(id => ({ source: row.source, id }))) };
    }

    /**
     * { point: [lng, lat] } or { name, bbox } → the street, its referable points and segments.
     * Throws 404 street-not-found, 400 for bad input; partial coverage is reported, never hidden.
     */
    async function read({ point = null, name = null, bbox = null } = {}) {
        if (!point && !(name && bbox)) throw fail(400, 'street-target-required', 'Give a point, or a street name with a bbox.');
        const centre = point || [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
        let box = point ? boxAround(point, START_HALF_DEG) : capped(bbox, centre);
        let loaded = await readWays(box);
        const seedOf = ways => {
            if (point) return S.streetAt(ways, point, { maxDistanceM: 30 });
            const key = S.normaliseName(name);
            const named = ways.filter(way => S.normaliseName(way.name) === key && S.ROAD_CLASSES.has(way.highway));
            const nearest = named.length ? S.streetAt(named, centre, { maxDistanceM: 1e7 }) : null;
            return nearest;
        };
        let seed = seedOf(loaded.ways);
        if (!seed) throw fail(404, 'street-not-found', point ? 'No named street runs within 30 m of this point.' : `No street named ${name} in this area.`);
        let street = S.streetWays(loaded.ways, { seedWayId: seed.wayId });
        for (let round = 0; round < 2 && nearEdge(boundsOf(street), box); round++) {
            const next = capped(grow(boundsOf(street), 0.004), centre);
            if (next.every((v, i) => Math.abs(v - box[i]) < 1e-9)) break;
            box = next;
            loaded = await readWays(box);
            street = S.streetWays(loaded.ways, { seedWayId: seed.wayId });
            if (!street.length) throw fail(404, 'street-not-found', 'The street could not be read again over its extent.');
        }
        const complete = !nearEdge(boundsOf(street), box) && !loaded.partial;
        const around = grow(boundsOf(street), MARGIN_DEG);
        const [buildings, addresses] = await Promise.all([
            fetchBuildings(around).then(fc => (fc.partial || fc.truncated ? null : fc.features)).catch(error => { log(`buildings unavailable: ${error.message}`); return null; }),
            fetchAddresses(around).then(fc => ({ features: fc.features, partial: !!(fc.partial || fc.truncated) })).catch(error => { log(`house numbers unavailable: ${error.message}`); return null; })
        ]);
        const numbers = (addresses?.features || []).map(f => ({ number: f.properties.number, street: f.properties.street, point: f.geometry.coordinates }));
        const result = S.segmentStreet({ ways: loaded.ways, street, buildings, numbers });
        const identityAll = await officialOf(result.name, street, around);
        const segments = [];
        for (const segment of result.segments) {
            const own = await officialOf(result.name, street.filter(way => segment.wayIds.includes(way.id)), around);
            segments.push({ ...segment, ...(own.official ? { official: own.official } : {}) });
        }
        log(`${result.name}: ${street.length} ways, ${segments.length} segments, ${numbers.length} numbers near, buildings ${buildings ? buildings.length : 'unknown'} (${loaded.source})`);
        return {
            street: { name: result.name, wayIds: result.wayIds, lengthM: result.lengthM, official: identityAll.official, officialIds: identityAll.officialIds, complete },
            points: result.points, segments,
            coverage: { ways: loaded.source, waysComplete: complete, buildings: buildings ? 'osm' : 'unavailable', numbers: addresses ? (addresses.partial ? 'partial' : 'osm') : 'unavailable' }
        };
    }
    return { read };
}
