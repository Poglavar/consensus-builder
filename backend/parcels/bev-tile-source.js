// Reconstructs full BEV cadastral parcels from maximum-resolution tiles, using the
// reference API only to locate every required tile; its rectangles are never parcel geometry.
import { VectorTile, classifyRings } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { bbox as geometryBbox, bboxPolygon, booleanIntersects, feature, intersect, multiPolygon, union } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';

export const BEV_TILES = 'https://kataster.bev.gv.at/tiles/kataster/{z}/{x}/{y}.pbf';
const LOCATOR = 'https://kataster.bev.gv.at/at.gv.bev.kataster/api/gst/';
const SEARCH = 'https://kataster.bev.gv.at/at.gv.bev.kataster/api/all/';
const ZOOM = 16, EXTENT = 65536, SCALE = 2 ** ZOOM * EXTENT;
const NATIVE_ID = /^\d{5}:\.?\d+(?:\/\d+)?$/;
const OUT_FIELDS = ['kg', 'gnr', 'ez', 'kgez', 'rstatus'];

function gridPoint([lon, lat]) {
    return [(lon + 180) / 360 * SCALE,
        (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * SCALE];
}

function wgsPoint([x, y]) {
    return [x / SCALE * 360 - 180, 180 / Math.PI * Math.atan(Math.sinh(Math.PI * (1 - 2 * y / SCALE)))];
}

function gridBounds(bounds) {
    const topLeft = gridPoint([bounds[0], bounds[3]]), bottomRight = gridPoint([bounds[2], bounds[1]]);
    return [...topLeft, ...bottomRight];
}

function overlaps(a, b) { return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]; }

// Core clipping must not leave an unmatched cut along a tile boundary. Comparing
// both sides catches missing fragments without treating the locator as an exact
// parcel envelope. A boundary exactly on a tile seam is conservatively rejected
// if no matching fragment exists on the other side.
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

function validateTileSeams(fragments) {
    // Adjacent tiles independently quantize their buffered coordinates. Allow
    // two encoded grid units at seam endpoints (one unit per side), without
    // moving vertices or filling gaps. A missing neighbour always fails.
    const epsilon = 2;
    for (const part of fragments) for (const [axis, boundary, dx, dy] of [
        [0, part.x * EXTENT, -1, 0], [0, (part.x + 1) * EXTENT, 1, 0],
        [1, part.y * EXTENT, 0, -1], [1, (part.y + 1) * EXTENT, 0, 1]
    ]) {
        const cuts = seamIntervals(part.geometry.geometry, axis, boundary);
        if (!cuts.length) continue;
        const opposite = fragments.filter(item => item.x === part.x + dx && item.y === part.y + dy)
            .flatMap(item => seamIntervals(item.geometry.geometry, axis, boundary)).sort((a, b) => a[0] - b[0]);
        if (!opposite.length) throw upstreamError('BEV parcel fragments do not close across a tile edge.');
        for (const [start, end] of cuts) {
            let covered = start;
            for (const [left, right] of opposite) {
                if (left > covered + epsilon) break;
                if (right >= covered) covered = right;
                if (covered >= end - epsilon) break;
            }
            if (covered < end - epsilon) throw upstreamError('BEV parcel fragments do not close across a tile edge.');
        }
    }
}

function tileList(bounds, maxTiles) {
    const indices = bounds.map(value => Math.floor(value / EXTENT));
    const [left, top, right, bottom] = indices;
    if (!indices.every(Number.isSafeInteger) || left < 0 || top < 0 || right >= 2 ** ZOOM || bottom >= 2 ** ZOOM
        || (right - left + 1) * (bottom - top + 1) > maxTiles) {
        throw upstreamError('BEV query exceeds the complete-tile limit; use a smaller area.');
    }
    const result = [];
    for (let x = left; x <= right; x++) for (let y = top; y <= bottom; y++) result.push([x, y]);
    return result;
}

async function mapBounded(values, fn) {
    const result = [];
    for (let i = 0; i < values.length; i += 3) {
        const batch = await Promise.allSettled(values.slice(i, i + 3).map(fn));
        const failed = batch.find(item => item.status === 'rejected');
        if (failed) throw failed.reason;
        result.push(...batch.map(item => item.value));
    }
    return result;
}

export function createBevTileParcelSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    const maxTiles = descriptor.maxTiles ?? 64, maxFeatures = descriptor.maxFeatures ?? 500;
    const maxBboxKm2 = descriptor.maxBboxKm2 ?? 1;
    if (!descriptor.id || !descriptor.idPrefix || descriptor.endpoint !== BEV_TILES
        || !Number.isSafeInteger(maxTiles) || maxTiles < 1 || maxTiles > 128
        || !Number.isSafeInteger(maxFeatures) || maxFeatures < 1 || maxFeatures > 1000
        || !Number.isFinite(maxBboxKm2) || maxBboxKm2 <= 0 || maxBboxKm2 > 4
        || typeof fetchImpl !== 'function') throw new Error('Invalid BEV parcel source descriptor.');
    const outputDescriptor = { ...descriptor, outFields: OUT_FIELDS, parcelNumberField: 'gnr' };

    function operation() {
        // A cache lives only for one operation. Exact-ID reads always observe current source data.
        const tiles = new Map();
        let totalBytes = 0;
        async function request(url, { json = false, allowAbsent = false } = {}) {
            const signal = AbortSignal.timeout(15000);
            try {
                const response = await fetchImpl(url, { signal, redirect: 'error', headers: { Accept: json ? 'application/json' : 'application/x-protobuf' } });
                if (!response.ok && !(allowAbsent && response.status === 404)) throw providerHttpError(response);
                const maxBytes = json ? 512 * 1024 : 4 * 1024 * 1024;
                if (Number(response.headers.get('content-length')) > maxBytes || !response.body?.getReader) {
                    throw upstreamError('BEV returned an oversized or unreadable response.');
                }
                const reader = response.body.getReader(), chunks = [];
                let size = 0;
                try {
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        size += value.byteLength;
                        totalBytes += value.byteLength;
                        if (size > maxBytes || totalBytes > 32 * 1024 * 1024) throw upstreamError('BEV response exceeds the byte limit.');
                        chunks.push(Buffer.from(value));
                    }
                } catch (error) {
                    try { await reader.cancel(); } catch { /* Already closed or interrupted. */ }
                    throw error;
                } finally { reader.releaseLock(); }
                const bytes = Buffer.concat(chunks, size);
                if (!json) return bytes;
                const payload = JSON.parse(bytes.toString('utf8'));
                if (response.status === 404) {
                    if (payload?.message === 'Grundstück nicht vorhanden') return null;
                    throw upstreamError('BEV could not confirm parcel absence.');
                }
                return payload;
            } catch (error) {
                if (error.status) throw error;
                if (signal.aborted || ['AbortError', 'TimeoutError'].includes(error.name)) throw upstreamError('BEV parcel request timed out.', 504);
                throw upstreamError('BEV returned an unavailable or invalid parcel response.');
            }
        }

        function tile(x, y) {
            const key = `${x},${y}`;
            if (!tiles.has(key)) {
                if (tiles.size >= maxTiles) throw upstreamError('BEV query exceeds the complete-tile limit; use a smaller area.');
                tiles.set(key, (async () => {
                    const bytes = await request(BEV_TILES.replace('{z}', ZOOM).replace('{x}', x).replace('{y}', y));
                    let layer;
                    try { layer = new VectorTile(new PbfReader(bytes)).layers.gst; }
                    catch { throw upstreamError('BEV returned an invalid vector tile.'); }
                    if (!layer) {
                        // Empty protobuf tiles legitimately contain no cadastral features.
                        if (!bytes.length) return [];
                        throw upstreamError('BEV tile omitted its cadastral layer.');
                    }
                    if (layer.extent !== EXTENT || layer.length > 20000) throw upstreamError('BEV tile resolution or feature count changed.');
                    const core = bboxPolygon([x * EXTENT, y * EXTENT, (x + 1) * EXTENT, (y + 1) * EXTENT]);
                    const fragments = [];
                    try {
                        for (let i = 0; i < layer.length; i++) {
                            const part = layer.feature(i), nativeId = `${part.properties.kg}:${part.properties.gnr}`;
                            if (part.type !== 3 || !NATIVE_ID.test(nativeId)) throw upstreamError('BEV tile returned invalid cadastral identity or geometry.');
                            const polygons = classifyRings(part.loadGeometry()).map(polygon => polygon.map(ring => ring.map(point => {
                                if (!Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y)
                                    || point.x < -EXTENT || point.x > 2 * EXTENT || point.y < -EXTENT || point.y > 2 * EXTENT) {
                                    throw upstreamError('BEV tile returned invalid coordinates.');
                                }
                                return [x * EXTENT + point.x, y * EXTENT + point.y];
                            })));
                            if (!polygons.length) throw upstreamError('BEV tile returned empty cadastral geometry.');
                            // Remove the provider's tile buffer before union. Each tile owns only its core.
                            const clipped = intersect(multiPolygon(polygons), core);
                            if (clipped) fragments.push({ nativeId, x, y, geometry: clipped, bounds: geometryBbox(clipped) });
                        }
                    } catch (error) {
                        if (error.status) throw error;
                        throw upstreamError('BEV tile geometry could not be decoded.');
                    }
                    return fragments;
                })());
            }
            return tiles.get(key);
        }

        async function parcel(nativeId) {
            const [kg, gnr] = nativeId.split(':');
            // The official search result contains a parcel locator envelope. The detail endpoint
            // also computes land-use/history data and can take >20 seconds for a simple road parcel.
            const search = await request(`${SEARCH}?${new URLSearchParams({ term: `${kg} ${gnr}`, layers: 'GST-KG' })}`, { json: true });
            if (search?.searchTerm !== `${kg} ${gnr}` || search.data?.type !== 'FeatureCollection'
                || (search.data.features !== undefined && (!Array.isArray(search.data.features) || search.data.features.length > 100))) {
                throw upstreamError('BEV parcel search returned inconsistent results.');
            }
            // BEV omits features on an empty search; still require exact-reference confirmation.
            const matches = (search.data.features || []).filter(item => `${item.properties?.kg}:${item.properties?.gnr}` === nativeId);
            if (matches.length > 1) throw upstreamError('BEV parcel search returned ambiguous identity.');
            // An autocomplete miss is not absence: only the exact endpoint can confirm that.
            // A slash is part of BEV's gnr path, not an encoded path segment.
            const locator = matches[0] || await request(`${LOCATOR}${kg}/${gnr}/`, { json: true, allowAbsent: true });
            if (locator === null) return null;
            if (locator.type !== 'Feature' || `${locator.properties?.kg}:${locator.properties?.gnr}` !== nativeId
                || !validateGeometry(locator.geometry)) throw upstreamError('BEV parcel locator returned inconsistent identity or bounds.');
            const expectedBounds = gridBounds(geometryBbox(locator));
            const needed = tileList(expectedBounds, maxTiles);
            const fragments = [];
            for (const [x, y] of needed) fragments.push(...(await tile(x, y)).filter(part => part.nativeId === nativeId));
            if (!fragments.length) throw upstreamError('BEV parcel locator has no corresponding tile geometry.');
            validateTileSeams(fragments);
            let merged = fragments[0].geometry;
            try { for (const part of fragments.slice(1)) merged = union(merged, part.geometry); }
            catch { throw upstreamError('BEV parcel fragments could not be reconstructed.'); }
            const actualBounds = geometryBbox(merged);
            // The generalized z16 outline can be smaller than the locator rectangle.
            // Require containment, allowing two encoded units for rounding at its envelope.
            if (actualBounds[0] < expectedBounds[0] - 2 || actualBounds[1] < expectedBounds[1] - 2
                || actualBounds[2] > expectedBounds[2] + 2 || actualBounds[3] > expectedBounds[3] + 2) {
                throw upstreamError('BEV parcel reconstruction exceeds its locator bounds.');
            }
            const mapCoordinates = coordinates => typeof coordinates[0] === 'number'
                ? wgsPoint(coordinates) : coordinates.map(mapCoordinates);
            const geometry = { type: merged.geometry.type, coordinates: mapCoordinates(merged.geometry.coordinates) };
            if (!validateGeometry(geometry)) throw upstreamError('BEV reconstructed invalid parcel geometry.');
            return canonicalParcelFeature(outputDescriptor, { type: 'Feature', geometry, properties: locator.properties }, nativeId);
        }

        async function bounds(bbox) {
            const grid = gridBounds(bbox), ids = new Set();
            for (const [x, y] of tileList(grid, maxTiles)) {
                for (const part of await tile(x, y)) {
                    if (overlaps(part.bounds, grid)) ids.add(part.nativeId);
                    if (ids.size > maxFeatures) throw upstreamError('BEV query exceeds the parcel limit; use a smaller area.');
                }
            }
            const features = await mapBounded([...ids].sort(), parcel);
            if (features.some(item => item === null)) throw upstreamError('BEV tile and parcel locator revisions disagree.');
            return collection(features);
        }
        return { bounds, parcel };
    }

    function collection(features) { return { type: 'FeatureCollection', features, complete: true, sourceId: descriptor.id, returnsWGS84: true }; }
    async function queryBounds(bbox) {
        validateBounds(bbox, maxBboxKm2);
        if (bbox[1] <= -85 || bbox[3] >= 85) throw new HttpError(400, 'Bounds exceed the BEV tile projection.');
        return operation().bounds(bbox);
    }
    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80) throw new HttpError(400, 'Provide between 1 and 80 parcel IDs.');
        const unique = [...new Set(ids)];
        const native = unique.map(value => {
            if (typeof value !== 'string' || !value.startsWith(descriptor.idPrefix)
                || value.length > 100 || !NATIVE_ID.test(value.slice(descriptor.idPrefix.length))) throw new HttpError(400, 'Invalid BEV parcel ID.');
            return value.slice(descriptor.idPrefix.length);
        });
        const current = operation(), parcels = await mapBounded(native, current.parcel);
        return { ...collection(parcels.filter(Boolean)), absentIds: unique.filter((_, index) => parcels[index] === null) };
    }
    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide a valid WGS84 Polygon or MultiPolygon.');
        const footprint = feature(geometry), result = await queryBounds(geometryBbox(footprint));
        return { ...result, features: result.features.filter(parcel => booleanIntersects(parcel, footprint)) };
    }
    return Object.freeze({ queryBounds, queryIds, queryGeometry });
}
