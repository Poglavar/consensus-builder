// Discover cadastral keys through Kadastr.com.ua's public tile index, then read unchanged
// full polygons from its landuse API. Tile fragments never become cadastral geometry.
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { bbox, bboxPolygon, booleanIntersects, feature } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { concatBytes } from './byte-utils.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';

export const KADASTR_LOOKUP_ROOT = 'https://back.geoserver.click/api/landuse/';
export const KADASTR_TILE_ENDPOINT = 'https://jdwepohzmflyupbpmxkg.supabase.co/functions/v1/kadastrova-karta-proxy';
const CADNUM = /^\d{10}:\d{2}:\d{3}:\d{4}$/;
const ZOOM = 16;
const MAX_BYTES = 16 * 1024 * 1024;

export function isKadastrResourceUrl(url) {
    if (url.username || url.password || url.hash) return false;
    if (url.origin === new URL(KADASTR_LOOKUP_ROOT).origin && !url.search) {
        try { return url.pathname.startsWith('/api/landuse/') && CADNUM.test(decodeURIComponent(url.pathname.slice('/api/landuse/'.length))); }
        catch { return false; }
    }
    if (`${url.origin}${url.pathname}` !== KADASTR_TILE_ENDPOINT
        || [...url.searchParams.keys()].some(key => !['z', 'x', 'y'].includes(key))) return false;
    return ['z', 'x', 'y'].every(key => url.searchParams.getAll(key).length === 1)
        && url.searchParams.get('z') === String(ZOOM)
        && ['x', 'y'].every(key => /^(0|[1-9]\d{0,4})$/.test(url.searchParams.get(key) || '')
            && Number(url.searchParams.get(key)) < 2 ** ZOOM);
}

export function createKadastrParcelSource(d, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    let endpoint;
    try { endpoint = new URL(d.endpoint); } catch { /* Rejected below. */ }
    if (d.id !== 'ua-kadastr-com-ua-landuse' || !d.idPrefix || !endpoint || !isKadastrResourceUrl(endpoint)
        || !d.endpoint.startsWith(KADASTR_LOOKUP_ROOT) || d.tileEndpoint !== KADASTR_TILE_ENDPOINT
        || d.idField !== 'cadnum' || d.parcelNumberField !== 'cadnum'
        || d.outFields?.length !== 1 || d.outFields[0] !== 'cadnum'
        || typeof fetchImpl !== 'function') throw new Error('Invalid Kadastr.com.ua source descriptor.');
    const maxFeatures = d.maxFeatures ?? 80, maxTiles = d.maxTiles ?? 9, maxBboxKm2 = d.maxBboxKm2 ?? 1;
    if (!Number.isInteger(maxFeatures) || maxFeatures < 1 || maxFeatures > 80
        || !Number.isInteger(maxTiles) || maxTiles < 1 || maxTiles > 9
        || !Number.isFinite(maxBboxKm2) || maxBboxKm2 <= 0 || maxBboxKm2 > 1) throw new Error('Invalid Kadastr.com.ua query limits.');
    const tiles = new Map(), geometries = new Map();
    function collection(features, extra = {}) {
        return { type: 'FeatureCollection', features, sourceId: d.id, returnsWGS84: true, complete: true,
            coverage: 'tile-indexed-parcels', citywideComplete: false, ...extra };
    }
    async function request(url, signal) {
        let response;
        try { response = await fetchImpl(url, { headers: { Accept: url.startsWith(KADASTR_LOOKUP_ROOT)
            ? 'application/json' : 'application/vnd.mapbox-vector-tile' }, credentials: 'omit',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000) }); }
        catch (error) {
            if (signal?.aborted) throw error;
            throw upstreamError('Kadastr.com.ua request failed.');
        }
        if (!response.ok) { await response.body?.cancel(); throw providerHttpError(response); }
        if (response.status === 204 && url.startsWith(KADASTR_TILE_ENDPOINT)) return new Uint8Array();
        const reader = response.body?.getReader();
        if (!reader) throw upstreamError('Kadastr.com.ua response is empty.');
        let size = 0;
        const chunks = [];
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > MAX_BYTES) { await reader.cancel(); throw upstreamError('Kadastr.com.ua response exceeds the byte limit.'); }
                chunks.push(value);
            }
        } finally { reader.releaseLock(); }
        return concatBytes(chunks, size);
    }
    async function exact(nativeId, signal) {
        const bytes = await request(`${KADASTR_LOOKUP_ROOT}${encodeURIComponent(nativeId)}`, signal);
        let row;
        try { row = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
        catch { throw upstreamError('Kadastr.com.ua returned invalid JSON.'); }
        // The fixed upstream payload has incidental attributes; only the exact cadnum and
        // necessary geometry cross this boundary. A missing/changed ID is never absence.
        const cadnum = row?.cadnum, geometry = row?.geometry;
        row = null;
        if (cadnum !== nativeId || !CADNUM.test(cadnum) || !validateGeometry(geometry)) {
            throw upstreamError('Kadastr.com.ua returned an unresolved cadastral polygon.');
        }
        return canonicalParcelFeature(d, { type: 'Feature', geometry, properties: { cadnum } }, cadnum);
    }
    function cached(map, key, ttl, limit, load) {
        const existing = map.get(key);
        if (existing && now() - existing.at < ttl) return existing.promise;
        const entry = { at: now(), promise: Promise.resolve().then(load) };
        map.delete(key);
        map.set(key, entry);
        while (map.size > limit) map.delete(map.keys().next().value);
        entry.promise.catch(() => { if (map.get(key) === entry) map.delete(key); });
        return entry.promise;
    }
    async function tile(x, y, signal) {
        return cached(tiles, `${x}/${y}`, 60000, 32, async () => {
            const url = new URL(KADASTR_TILE_ENDPOINT);
            url.search = new URLSearchParams({ z: String(ZOOM), x: String(x), y: String(y) });
            const bytes = await request(url.href, signal);
            // Empty map cells are HTTP 204 or a relayed HTTP 200 zero-byte MVT.
            // This is empty index coverage, never proof that an exact cadastral ID is absent.
            if (!bytes.length) return [];
            let layer;
            try { layer = new VectorTile(new PbfReader(bytes)).layers.land_polygons; }
            catch { throw upstreamError('Kadastr.com.ua returned an invalid parcel index.'); }
            if (!layer || layer.extent !== 4096 || layer.length > 50000) throw upstreamError('Kadastr.com.ua parcel index contract changed.');
            const index = [];
            for (let i = 0; i < layer.length; i++) {
                const part = layer.feature(i);
                if (part.type !== 3) continue;
                const cadnum = part.properties.cadnum;
                if (typeof cadnum !== 'string' || !CADNUM.test(cadnum)) throw upstreamError('Kadastr.com.ua parcel index is missing cadastral keys.');
                // Decoded tile geometry is transient spatial indexing only. No tile attributes
                // other than the native key leave the decoder or enter the feature cache.
                index.push({ cadnum, geometry: part.toGeoJSON(x, y, ZOOM).geometry });
            }
            return index;
        });
    }
    async function queryIds(ids, { signal } = {}) {
        if (!Array.isArray(ids) || ids.length > 80 || ids.some(id => typeof id !== 'string'
            || !id.startsWith(d.idPrefix) || !CADNUM.test(id.slice(d.idPrefix.length)))) {
            throw new HttpError(400, 'Provide at most 80 canonical cadastral parcel IDs.');
        }
        const features = [];
        // Exact reads always reach the provider, including repeated reads on the same adapter.
        for (const id of new Set(ids)) features.push(await exact(id.slice(d.idPrefix.length), signal));
        return collection(features, { queryType: 'ids', absentIds: [] });
    }
    async function queryBounds(bounds, { signal } = {}) {
        validateBounds(bounds, maxBboxKm2);
        if (bounds[1] <= -85 || bounds[3] >= 85) throw new HttpError(400, 'Parcel index latitude is out of range.');
        const tileAt = ([lon, lat]) => [Math.floor((lon + 180) / 360 * 2 ** ZOOM),
            Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** ZOOM)];
        const [west, north] = tileAt([bounds[0], bounds[3]]), [east, south] = tileAt([bounds[2], bounds[1]]);
        if ((east - west + 1) * (south - north + 1) > maxTiles) throw new HttpError(400, 'Parcel query exceeds the tile budget.');
        const view = bboxPolygon(bounds), ids = new Set();
        for (let x = west; x <= east; x++) for (let y = north; y <= south; y++) {
            for (const row of await tile(x, y, signal)) if (booleanIntersects(feature(row.geometry), view)) ids.add(row.cadnum);
        }
        if (ids.size > maxFeatures) throw new HttpError(400, 'Parcel query exceeds the feature budget; request a smaller window.');
        const features = [];
        for (const id of [...ids].sort()) {
            const parcel = await cached(geometries, id, 60000, 160, () => exact(id, signal));
            if (booleanIntersects(parcel, view)) features.push(parcel);
        }
        // Complete means the bounded tile-index query resolved every discovered key. It does
        // not establish that the provider indexes every parcel, or that its index is current.
        return collection(features, { queryType: 'bounds', indexedIdCount: ids.size });
    }
    async function queryGeometry(geometry, options) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide a WGS84 polygon.');
        const shape = feature(geometry), result = await queryBounds(bbox(shape), options);
        return { ...result, features: result.features.filter(parcel => booleanIntersects(parcel, shape)), queryType: 'geometry' };
    }
    return Object.freeze({ queryIds, queryBounds, queryGeometry });
}
