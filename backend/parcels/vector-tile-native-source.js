// Native cadastral keys in a bounded tile window. Only whole, strictly interior source
// polygons belong to this scope; tile-edge fragments remain unresolved, never repaired.
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { bbox, bboxPolygon, booleanIntersects, feature } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';
import { concatBytes } from './byte-utils.js';

async function readTileBytes(response) {
    const reader = response.body?.getReader();
    if (!reader) throw upstreamError('Native parcel tile has no readable body.');
    const chunks = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 16 * 1024 * 1024) throw upstreamError('Native parcel tile exceeds the byte limit.');
            chunks.push(value);
        }
    } finally { await reader.cancel(); reader.releaseLock(); }
    if (!size) throw upstreamError('Native parcel tile has invalid size.');
    return concatBytes(chunks, size);
}

export function createNativeInteriorTileSource(d, { fetchImpl = globalThis.fetch } = {}) {
    const { zoom, extent = 4096, maxTiles = 9, maxFeatures = 4000, maxBboxKm2 = 4 } = d;
    let url;
    try { url = new URL(d.endpoint); } catch { /* Validation below. */ }
    if (!d.id || !d.idPrefix || !url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
        || !['{z}', '{x}', '{y}'].every(token => d.endpoint.includes(token))
        || !Number.isSafeInteger(zoom) || zoom < 10 || zoom > 18 || extent !== 4096
        || !d.layer || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(d.idField || '')
        || d.idType !== 'string' || d.outFields?.length !== 1 || d.outFields[0] !== d.idField
        || d.parcelNumberField !== d.idField || d.overlapResolution !== undefined
        || !Number.isSafeInteger(maxTiles) || maxTiles < 1 || maxTiles > 64
        || !Number.isSafeInteger(maxFeatures) || maxFeatures < 1 || maxFeatures > 10000
        || !Number.isFinite(maxBboxKm2) || maxBboxKm2 <= 0 || maxBboxKm2 > 9
        || typeof fetchImpl !== 'function') throw new Error('Invalid native interior tile descriptor.');
    validateBounds(d.idLookupBounds, 100);
    const tileAt = ([lon, lat]) => [Math.floor((lon + 180) / 360 * 2 ** zoom),
        Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** zoom)];
    const [west, north] = tileAt([d.idLookupBounds[0], d.idLookupBounds[3] - 1e-10]);
    const [east, south] = tileAt([d.idLookupBounds[2] - 1e-10, d.idLookupBounds[1] + 1e-10]);
    if ((east - west + 1) * (south - north + 1) > maxTiles || d.idLookupBounds[1] <= -85 || d.idLookupBounds[3] >= 85) {
        throw new Error('Native parcel lookup window exceeds its tile budget.');
    }
    let pending;
    const collection = (features, extra = {}) => ({ type: 'FeatureCollection', features, sourceId: d.id,
        returnsWGS84: true, complete: true, coverage: 'whole-interior-polygons-only', ...extra });
    async function read() {
        const byId = new Map(), unresolved = new Set();
        let excludedFragments = 0;
        for (let x = west; x <= east; x++) for (let y = north; y <= south; y++) {
            let response;
            try { response = await fetchImpl(d.endpoint.replace('{z}', zoom).replace('{x}', x).replace('{y}', y),
                { signal: AbortSignal.timeout(20000) }); }
            catch { throw upstreamError('Native parcel tile service is unavailable.'); }
            if (!response.ok) throw providerHttpError(response);
            const bytes = await readTileBytes(response);
            let layer;
            try { layer = new VectorTile(new PbfReader(bytes)).layers[d.layer]; }
            catch { throw upstreamError('Native parcel tile could not be decoded.'); }
            if (!layer || layer.extent !== extent || layer.length > 50000) throw upstreamError('Native parcel layer contract changed.');
            for (let i = 0; i < layer.length; i++) {
                const row = layer.feature(i);
                if (row.type !== 3) continue;
                const nativeId = row.properties[d.idField];
                // No row attributes except the native cadastral key leave the decoder.
                if (typeof nativeId !== 'string' || !/^[0-9]{1,64}$/.test(nativeId)) throw upstreamError('Native cadastral key is missing or unsafe.');
                const rings = row.loadGeometry();
                if (rings.some(ring => ring.some(p => p.x <= 0 || p.y <= 0 || p.x >= extent || p.y >= extent))) {
                    unresolved.add(nativeId); excludedFragments++; continue;
                }
                const geometry = row.toGeoJSON(x, y, zoom).geometry;
                if (!validateGeometry(geometry)) throw upstreamError('Native parcel polygon is invalid.');
                const parcel = canonicalParcelFeature(d, { type: 'Feature', geometry,
                    properties: { [d.idField]: nativeId } }, nativeId);
                const previous = byId.get(parcel.id);
                if (previous && JSON.stringify(previous.geometry) !== JSON.stringify(geometry)) {
                    throw upstreamError('Native cadastral key has conflicting whole polygons.');
                }
                byId.set(parcel.id, parcel);
                if (byId.size > maxFeatures) throw upstreamError('Native parcel window exceeds its feature budget.');
            }
        }
        return { features: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)), unresolved, excludedFragments };
    }
    function load() {
        if (!pending) { pending = read(); pending.catch(() => { pending = null; }); }
        return pending;
    }
    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80 || ids.some(id => typeof id !== 'string'
            || !id.startsWith(d.idPrefix) || !/^[0-9]{1,64}$/.test(id.slice(d.idPrefix.length)))) {
            throw new HttpError(400, 'Provide 1–80 native parcel IDs belonging to this source.');
        }
        const result = await load(), wanted = [...new Set(ids)];
        const features = result.features.filter(parcel => wanted.includes(parcel.id));
        // An absent key may be outside the bounded window, or belong to an unresolved
        // edge parcel. Never turn either into authoritative cadastral absence.
        if (features.length !== wanted.length) throw upstreamError('Native parcel is unresolved or outside the qualified tile window.');
        return collection(features, { absentIds: [] });
    }
    async function queryBounds(bounds) {
        validateBounds(bounds, maxBboxKm2);
        const view = bboxPolygon(bounds), result = await load();
        return collection(result.features.filter(parcel => booleanIntersects(parcel, view)),
            { excludedTileFragments: result.excludedFragments, citywideComplete: false,
                complete: bounds[0] >= d.idLookupBounds[0] && bounds[1] >= d.idLookupBounds[1]
                    && bounds[2] <= d.idLookupBounds[2] && bounds[3] <= d.idLookupBounds[3] });
    }
    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide a WGS84 parcel polygon.');
        const result = await queryBounds(bbox(feature(geometry)));
        return { ...result, features: result.features.filter(parcel => booleanIntersects(parcel, feature(geometry))) };
    }
    return Object.freeze({ queryIds, queryBounds, queryGeometry });
}
