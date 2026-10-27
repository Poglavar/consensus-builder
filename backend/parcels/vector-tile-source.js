// Reconstructs parcels from a fixed vector-tile snapshot (e.g. indianopenmaps.com cadastral routes):
// each tile's fragments are cut back to the tile core, neighbouring tiles are read until every cut
// closes, and a source row's fragments are joined. References are derived from the joined outline.
import { VectorTile, classifyRings } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { bbox as geometryBbox, bboxPolygon, booleanIntersects, feature as geoFeature, intersect, multiPolygon, union } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';
import { geometryParcelFeature, parseGeometryParcelId, geometryLookupBounds, GEOMETRY_IDENTITY_KIND } from './geometry-identity.js';
import { OVERLAP_GROUND_POLICY, withOverlapGround } from './overlap-ground.js';
import { createNativeInteriorTileSource } from './vector-tile-native-source.js';
import { createGeographicInteriorTileSource } from './vector-tile-geographic-source.js';
import { createNcaParcelSource, isNcaSource } from './by-nca-source.js';

const columnName = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_.()]{0,63}$/.test(value);
const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
// Adjacent tiles simplify their buffered copies independently: a cut may be matched by its
// neighbour up to two encoded units away (as for BEV), never left open.
const SEAM_EPSILON = 2;
// Tile builders simplify each tile on its own and drop polygons smaller than about a pixel. A cut
// the neighbour does not touch at all is accepted only up to a dropped sliver (16 units, ~10 m at
// zoom 14); a cut the neighbour matches in part may be left open by up to 64 units (1.6% of a tile
// edge) where the two tiles simplified the shared corner differently. Anything longer fails.
const DROPPED_SLIVER_UNITS = 16;
const SIMPLIFIED_GAP_UNITS = 64;
const TILE_CACHE_SIZE = 96;

function seamIntervals(geometry, axis, boundary) {
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    const intervals = [];
    for (const polygon of polygons) for (const ring of polygon) for (let i = 1; i < ring.length; i++) {
        const a = ring[i - 1], b = ring[i];
        if (a[axis] === boundary && b[axis] === boundary && a[1 - axis] !== b[1 - axis]) {
            intervals.push([Math.min(a[1 - axis], b[1 - axis]), Math.max(a[1 - axis], b[1 - axis])]);
        }
    }
    return intervals.sort((a, b) => a[0] - b[0]);
}

// The four sides of a fragment's tile with a cut along them: [axis, boundary, dx, dy].
function cutSides(fragment, extent) {
    return [[0, fragment.x * extent, -1, 0], [0, (fragment.x + 1) * extent, 1, 0],
        [1, fragment.y * extent, 0, -1], [1, (fragment.y + 1) * extent, 0, 1]]
        .filter(([axis, boundary]) => seamIntervals(fragment.geometry.geometry, axis, boundary).length);
}

// Returns the number of cuts accepted with a sliver gap, or -1 when a cut does not close.
function seamsClose(fragments, extent) {
    let slivers = 0;
    for (const part of fragments) for (const [axis, boundary, dx, dy] of cutSides(part, extent)) {
        const cuts = seamIntervals(part.geometry.geometry, axis, boundary);
        const opposite = fragments.filter(item => item.x === part.x + dx && item.y === part.y + dy)
            .flatMap(item => seamIntervals(item.geometry.geometry, axis, boundary)).sort((a, b) => a[0] - b[0]);
        for (const [start, end] of cuts) {
            // Length of the cut that no neighbouring fragment covers (gaps within the epsilon count as covered).
            let covered = start, gap = 0, matched = false;
            for (const [left, right] of opposite) {
                if (right <= covered) continue;
                if (left >= end) break;
                matched = true;
                if (left > covered + SEAM_EPSILON) gap += left - covered;
                covered = Math.max(covered, right);
                if (covered >= end) break;
            }
            if (covered < end - SEAM_EPSILON) gap += end - covered;
            if (gap > (matched ? SIMPLIFIED_GAP_UNITS : DROPPED_SLIVER_UNITS)) return -1;
            if (gap > 0) slivers++;
        }
    }
    return slivers;
}

// Splits one key's fragments into parcels: fragments join only where their cuts meet across a
// shared tile edge, so a repeated key or a distant part never changes another parcel's outline.
function connectedParts(fragments) {
    const parent = fragments.map((_, index) => index);
    const find = index => parent[index] === index ? index : (parent[index] = find(parent[index]));
    for (let i = 0; i < fragments.length; i++) for (let j = i + 1; j < fragments.length; j++) {
        const a = fragments[i], b = fragments[j], dx = b.x - a.x, dy = b.y - a.y;
        if (Math.abs(dx) + Math.abs(dy) !== 1) continue;
        const axis = dx ? 0 : 1, boundary = dx ? Math.max(a.x, b.x) * a.extent : Math.max(a.y, b.y) * a.extent;
        const left = seamIntervals(a.geometry.geometry, axis, boundary), right = seamIntervals(b.geometry.geometry, axis, boundary);
        if (left.some(([s1, e1]) => right.some(([s2, e2]) => s1 <= e2 + SEAM_EPSILON && s2 <= e1 + SEAM_EPSILON))) parent[find(i)] = find(j);
    }
    const groups = new Map();
    fragments.forEach((fragment, index) => {
        const root = find(index);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(fragment);
    });
    return [...groups.values()];
}

export function createVectorTileParcelSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    if (descriptor.tileMatrix === 'geographic-2x1') return createGeographicInteriorTileSource(descriptor, { fetchImpl });
    if (descriptor.identityKind === 'native' && descriptor.geometryMode === 'interior-only') {
        if (isNcaSource(descriptor)) return createNcaParcelSource(descriptor, { fetchImpl });
        return createNativeInteriorTileSource(descriptor, { fetchImpl });
    }
    const { id, endpoint, idPrefix, layer, groupFields, outFields, parcelNumberField } = descriptor;
    const zoom = descriptor.zoom, extent = descriptor.extent ?? 4096;
    const maxTiles = descriptor.maxTiles ?? 36, maxFeatures = descriptor.maxFeatures ?? 4000;
    const maxBboxKm2 = descriptor.maxBboxKm2 ?? 1, lookupCellSize = descriptor.lookupCellSize ?? 0.002;
    let url;
    try { url = new URL(endpoint.replace('{z}', 0).replace('{x}', 0).replace('{y}', 0)); } catch { url = null; }
    if (!id || !idPrefix || !url || url.protocol !== 'https:' || !['{z}', '{x}', '{y}'].every(token => endpoint.includes(token))
        || descriptor.identityKind !== GEOMETRY_IDENTITY_KIND
        || !Number.isSafeInteger(zoom) || zoom < 10 || zoom > 18 || ![512, 1024, 2048, 4096, 8192].includes(extent)
        || typeof layer !== 'string' || !layer.length
        || !Array.isArray(groupFields) || !groupFields.length || groupFields.length > 4 || !groupFields.every(columnName)
        || !Array.isArray(outFields) || !outFields.length || !outFields.every(columnName)
        || !groupFields.every(field => outFields.includes(field))
        || (parcelNumberField !== undefined && !outFields.includes(parcelNumberField))
        || !Number.isSafeInteger(maxTiles) || maxTiles < 1 || maxTiles > 64
        || !Number.isSafeInteger(maxFeatures) || maxFeatures < 1 || maxFeatures > 10000
        || !Number.isFinite(maxBboxKm2) || maxBboxKm2 <= 0 || maxBboxKm2 > 9
        || !Number.isFinite(lookupCellSize) || lookupCellSize < 0.0001 || lookupCellSize > 0.005
        || ![undefined, OVERLAP_GROUND_POLICY].includes(descriptor.overlapResolution)
        || typeof fetchImpl !== 'function') throw new Error('Invalid vector-tile parcel source descriptor.');
    const scale = 2 ** zoom * extent;
    const gridPoint = ([lon, lat]) => [(lon + 180) / 360 * scale,
        (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * scale];
    const wgsPoint = ([x, y]) => [x / scale * 360 - 180, 180 / Math.PI * Math.atan(Math.sinh(Math.PI * (1 - 2 * y / scale)))];
    // The snapshot does not change between reads, so decoded tiles are shared across queries.
    const tiles = new Map();

    async function download(x, y) {
        const signal = AbortSignal.timeout(20000);
        let response;
        try {
            response = await fetchImpl(endpoint.replace('{z}', zoom).replace('{x}', x).replace('{y}', y), { signal });
        } catch (error) {
            if (signal.aborted || ['AbortError', 'TimeoutError'].includes(error.name)) throw upstreamError('Parcel tile request timed out.', 504);
            throw upstreamError('Parcel tile service is unavailable.');
        }
        // An empty tile is answered with 404 or 204 and holds no parcels.
        if (response.status === 404 || response.status === 204) return new Uint8Array();
        if (!response.ok) throw providerHttpError(response);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > 16 * 1024 * 1024) throw upstreamError('Parcel tile exceeds the byte limit.');
        return bytes;
    }

    function decode(bytes, x, y) {
        if (!bytes.length) return [];
        let source;
        try { source = new VectorTile(new PbfReader(bytes)).layers[layer]; }
        catch { throw upstreamError('Parcel tile service returned an invalid vector tile.'); }
        if (!source) return [];
        if (source.extent !== extent || source.length > 50000) throw upstreamError('Parcel tile resolution or feature count changed.');
        const core = bboxPolygon([x * extent, y * extent, (x + 1) * extent, (y + 1) * extent]);
        const fragments = [];
        for (let i = 0; i < source.length; i++) {
            const part = source.feature(i);
            if (part.type !== 3) continue;
            // A row missing its key is grouped by its whole attribute set, which its fragments share.
            let key = groupFields.map(field => part.properties[field]);
            if (key.some(value => value === undefined || value === null || value === '')) {
                key = ['row', Object.entries(part.properties).sort(([a], [b]) => a < b ? -1 : 1)];
            }
            let polygons;
            try {
                polygons = classifyRings(part.loadGeometry()).map(polygon => polygon.map(ring => ring.map(point => [x * extent + point.x, y * extent + point.y])));
            } catch { throw upstreamError('Parcel tile geometry could not be decoded.'); }
            if (!polygons.length) continue;
            // Each tile owns only its core; the buffer copy belongs to the neighbour.
            let clipped;
            try { clipped = intersect(multiPolygon(polygons), core); } catch { throw upstreamError('Parcel tile geometry could not be clipped.'); }
            if (!clipped) continue;
            const properties = Object.fromEntries(outFields.map(field => [field, part.properties[field] ?? null]));
            fragments.push({ key: JSON.stringify(key), x, y, extent, geometry: clipped, bounds: geometryBbox(clipped), properties });
        }
        return fragments;
    }

    function tile(x, y) {
        const key = `${x},${y}`;
        if (tiles.has(key)) {
            const hit = tiles.get(key);
            tiles.delete(key); tiles.set(key, hit);
            return hit;
        }
        const pending = download(x, y).then(bytes => decode(bytes, x, y));
        pending.catch(() => tiles.delete(key));
        tiles.set(key, pending);
        if (tiles.size > TILE_CACHE_SIZE) tiles.delete(tiles.keys().next().value);
        return pending;
    }

    async function load(keys) {
        const out = [];
        for (let i = 0; i < keys.length; i += 3) out.push(...await Promise.all(keys.slice(i, i + 3).map(([x, y]) => tile(x, y))));
        return out;
    }

    async function queryBounds(bbox) {
        validateBounds(bbox, maxBboxKm2);
        if (bbox[1] <= -85 || bbox[3] >= 85) throw new HttpError(400, 'Bounds exceed the tile projection.');
        const [left, top] = gridPoint([bbox[0], bbox[3]]), [right, bottom] = gridPoint([bbox[2], bbox[1]]);
        const grid = [left, top, right, bottom];
        const loaded = new Map(), want = [];
        for (let x = Math.floor(left / extent); x <= Math.floor(right / extent); x++)
            for (let y = Math.floor(top / extent); y <= Math.floor(bottom / extent); y++) want.push([x, y]);
        const byKey = new Map();
        const add = async list => {
            const fresh = list.filter(([x, y]) => !loaded.has(`${x},${y}`));
            if (loaded.size + fresh.length > maxTiles) throw upstreamError('Parcel query needs more tiles than allowed; use a smaller area.');
            const results = await load(fresh);
            fresh.forEach(([x, y], index) => {
                loaded.set(`${x},${y}`, true);
                for (const fragment of results[index]) {
                    if (!byKey.has(fragment.key)) byKey.set(fragment.key, []);
                    byKey.get(fragment.key).push(fragment);
                }
            });
        };
        await add(want);
        // A parcel is one connected set of a row's fragments; it is selected when any of them meets the view.
        const parcelsInView = () => [...byKey.values()].flatMap(connectedParts)
            .filter(parts => parts.some(fragment => overlaps(fragment.bounds, grid)));
        // Follow every cut of a selected parcel into the neighbouring tile until all of them close.
        for (;;) {
            const selected = parcelsInView();
            if (selected.length > maxFeatures) throw upstreamError('Parcel query exceeds the parcel limit; use a smaller area.');
            const needed = new Map();
            for (const parts of selected) for (const fragment of parts) for (const [, , dx, dy] of cutSides(fragment, extent)) {
                const x = fragment.x + dx, y = fragment.y + dy;
                if (!loaded.has(`${x},${y}`)) needed.set(`${x},${y}`, [x, y]);
            }
            if (!needed.size) break;
            await add([...needed.values()]);
        }
        const view = bboxPolygon(bbox), byId = new Map();
        let droppedSliverCuts = 0;
        for (const fragments of parcelsInView()) {
            const slivers = seamsClose(fragments, extent);
            if (slivers < 0) throw upstreamError('Parcel tile fragments do not close across a tile edge.');
            droppedSliverCuts += slivers;
            let merged = fragments[0].geometry;
            try { for (const part of fragments.slice(1)) merged = union(merged, part.geometry) || merged; }
            catch { throw upstreamError('Parcel tile fragments could not be joined.'); }
            const toWgs = coordinates => typeof coordinates[0] === 'number' ? wgsPoint(coordinates) : coordinates.map(toWgs);
            const geometry = { type: merged.geometry.type, coordinates: toWgs(merged.geometry.coordinates) };
            if (!validateGeometry(geometry) || !booleanIntersects(geoFeature(geometry), view)) continue;
            const parcel = geometryParcelFeature(descriptor, { type: 'Feature', geometry, properties: {} });
            const properties = fragments[0].properties;
            const label = parcelNumberField ? String(properties[parcelNumberField] ?? '') : '';
            const previous = byId.get(parcel.id);
            if (previous) {
                // Two rows with one outline keep one reference and both labels.
                const labels = new Set([...String(previous.properties.parcelNumber || '').split(' / '), label].filter(Boolean));
                previous.properties.parcelNumber = [...labels].join(' / ') || null;
                continue;
            }
            parcel.properties.parcelNumber = label || null;
            parcel.properties.sourceProperties = properties;
            byId.set(parcel.id, parcel);
        }
        return { type: 'FeatureCollection', features: [...byId.values()].sort((a, b) => a.id < b.id ? -1 : 1), complete: true, sourceId: id, returnsWGS84: true, tileCount: loaded.size, droppedSliverCuts };
    }

    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80) throw new HttpError(400, 'Provide between 1 and 80 parcel IDs.');
        const unique = [...new Set(ids)];
        const features = [], absentIds = [];
        for (const value of unique) {
            const locator = parseGeometryParcelId(descriptor, value);
            // The reference names one vertex; the outline it hashes is read from the cell around it.
            const result = await queryBounds(geometryLookupBounds(locator, lookupCellSize));
            const match = result.features.find(parcel => parcel.id === value);
            if (match) features.push(match); else absentIds.push(value);
        }
        return { type: 'FeatureCollection', features, complete: true, sourceId: id, returnsWGS84: true, absentIds };
    }

    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide a valid WGS84 Polygon or MultiPolygon.');
        const footprint = geoFeature(geometry), result = await queryBounds(geometryBbox(footprint));
        return { ...result, features: result.features.filter(parcel => booleanIntersects(parcel, footprint)) };
    }

    const adapter = Object.freeze({ queryBounds, queryIds, queryGeometry });
    return descriptor.overlapResolution === OVERLAP_GROUND_POLICY ? withOverlapGround(adapter, { maxBboxKm2 }) : adapter;
}
