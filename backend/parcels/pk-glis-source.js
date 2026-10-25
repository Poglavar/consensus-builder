// GLIS khasra records: bounded mauza reads for the map and fresh native-ID reads.
import { bbox, bboxPolygon, booleanIntersects, feature } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { concatBytes } from './byte-utils.js';
import { canonicalParcelFeature, validateBounds, validateGeometry, upstreamError, providerHttpError } from './source-contract.js';

export const GLIS_ENDPOINT = 'https://api.ssbacha.net/api/parcels/filtered';
const UID = /^\d+(?:-\d+){4}-[A-Za-z0-9./]+$/;
const intersects = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

export function createGlisParcelSource(input, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    const d = structuredClone(input);
    const cap = d.maxResponseBytes ?? 1024 * 1024;
    const maxFeatures = d.maxFeatures ?? 1000;
    const timeoutMs = d.timeoutMs ?? 20000;
    if (d.endpoint !== GLIS_ENDPOINT || !d.id || !d.idPrefix || d.idField !== 'khasra_uid'
        || JSON.stringify(d.outFields) !== JSON.stringify(['khasra_uid'])
        || !Number.isSafeInteger(cap) || cap < 1024 || cap > 1024 * 1024
        || !Number.isSafeInteger(maxFeatures) || maxFeatures < 1 || maxFeatures > 1000
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 25000
        || !Array.isArray(d.scopes) || !d.scopes.length || d.scopes.length > 16
        || d.scopes.some(s => ['district', 'tehsil', 'mauza'].some(k => typeof s[k] !== 'string'
            || !/^[A-Za-z0-9 -]{1,80}$/.test(s[k])) || !/^\d+(?:-\d+){4}-$/.test(s.uidPrefix)
            || !Array.isArray(s.extent) || s.extent.length !== 4 || !s.extent.every(Number.isFinite)
            || s.extent[0] >= s.extent[2] || s.extent[1] >= s.extent[3]
            || s.extent[0] < -180 || s.extent[2] > 180 || s.extent[1] < -90 || s.extent[3] > 90)
        || new Set(d.scopes.map(s => s.uidPrefix)).size !== d.scopes.length) {
        throw new Error('Invalid GLIS parcel descriptor.');
    }
    const cache = new Map();
    const result = (features, extra = {}) => ({ type: 'FeatureCollection', sourceId: d.id,
        features: structuredClone(features), returnsWGS84: true, complete: true,
        areaComplete: false, authoritativeAbsence: false, ...extra });

    async function read(scope, khasra, callerSignal) {
        const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
        const response = await fetchImpl(d.endpoint, { method: 'POST', redirect: 'error', signal,
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ district: scope.district, tehsil: scope.tehsil, mauza: scope.mauza,
                ...(khasra === undefined ? {} : { khasra }), outFields: ['khasra_uid'] }) });
        if (!response.ok) { await response.body?.cancel(); throw providerHttpError(response); }
        const reader = response.body?.getReader();
        if (!reader) throw upstreamError('GLIS returned no readable parcel response.');
        const chunks = [];
        let bytes = 0, payload;
        try {
            for (;;) {
                const part = await reader.read();
                if (part.done) break;
                bytes += part.value.byteLength;
                if (bytes > cap) throw upstreamError('GLIS mauza response exceeds its actual byte cap.');
                chunks.push(part.value);
            }
            try { payload = JSON.parse(new TextDecoder().decode(concatBytes(chunks, bytes))); }
            catch { throw upstreamError('GLIS returned invalid JSON.'); }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const rows = payload?.data?.features;
        if (payload?.success !== true || payload?.data?.type !== 'FeatureCollection' || !Array.isArray(rows)
            || !Number.isSafeInteger(payload.count) || payload.count !== rows.length || rows.length > maxFeatures
            || (payload.data.crs !== undefined && !['EPSG:4326', 'urn:ogc:def:crs:OGC:1.3:CRS84',
                'urn:ogc:def:crs:EPSG::4326'].includes(payload.data.crs?.properties?.name ?? payload.data.crs))) {
            throw upstreamError('GLIS returned an incomplete collection or unexpected coordinate system.');
        }
        const seen = new Set();
        return rows.map(row => {
            const uid = row.properties?.khasra_uid;
            if (row.type !== 'Feature' || typeof uid !== 'string' || !UID.test(uid) || !uid.startsWith(scope.uidPrefix)
                || (khasra !== undefined && uid.slice(scope.uidPrefix.length) !== khasra)
                || seen.has(uid) || !validateGeometry(row.geometry)) {
                throw upstreamError('GLIS returned inconsistent native IDs or unusable polygon geometry.');
            }
            seen.add(uid);
            const extent = bbox(row);
            if (extent[0] < scope.extent[0] - 1e-8 || extent[1] < scope.extent[1] - 1e-8
                || extent[2] > scope.extent[2] + 1e-8 || extent[3] > scope.extent[3] + 1e-8) {
                throw upstreamError('GLIS polygon exceeds the configured mauza extent; refresh source scope.');
            }
            // The service ignores outFields. Drop all unsolicited record attributes immediately.
            return canonicalParcelFeature(d, { geometry: row.geometry, properties: { khasra_uid: uid } }, uid);
        });
    }

    async function scopedRows(scope) {
        const previous = cache.get(scope.uidPrefix);
        if (previous && now() < previous.expires) return previous.pending;
        const entry = { expires: now() + 60000 };
        entry.pending = read(scope).catch(error => { if (cache.get(scope.uidPrefix) === entry) cache.delete(scope.uidPrefix); throw error; });
        cache.set(scope.uidPrefix, entry);
        return entry.pending;
    }

    async function queryBounds(bounds, { signal } = {}) {
        validateBounds(bounds, d.maxBboxKm2 ?? 2);
        signal?.throwIfAborted();
        const polygon = bboxPolygon(bounds), rows = [];
        for (const scope of d.scopes.filter(s => intersects(bounds, s.extent))) {
            rows.push(...(await scopedRows(scope)).filter(row => booleanIntersects(row, polygon)));
            signal?.throwIfAborted();
        }
        return result(rows);
    }

    async function queryIds(ids, { signal } = {}) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80) throw new HttpError(400, 'Provide 1–80 GLIS parcel IDs.');
        const unique = [...new Set(ids)];
        const queries = unique.map(id => {
            if (typeof id !== 'string' || !id.startsWith(d.idPrefix) || !UID.test(id.slice(d.idPrefix.length))) {
                throw new HttpError(400, 'Invalid GLIS parcel ID.');
            }
            const uid = id.slice(d.idPrefix.length), scope = d.scopes.find(s => uid.startsWith(s.uidPrefix));
            if (!scope) throw new HttpError(400, 'GLIS parcel ID is outside the configured mauzas.');
            return { scope, khasra: uid.slice(scope.uidPrefix.length) };
        });
        const rows = [];
        for (const query of queries) rows.push(...await read(query.scope, query.khasra, signal));
        const found = new Set(rows.map(row => row.id));
        // Empty/404 reads are not evidence of cadastral absence outside this digitized subset.
        return result(rows, { complete: unique.every(id => found.has(id)), absentIds: [] });
    }

    async function queryGeometry(geometry, options) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide WGS84 parcel query geometry.');
        const response = await queryBounds(bbox(geometry), options);
        return { ...response, features: response.features.filter(row => booleanIntersects(row, feature(geometry))) };
    }
    return Object.freeze({ queryBounds, queryIds, queryGeometry });
}
