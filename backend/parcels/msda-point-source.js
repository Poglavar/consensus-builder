// Point-identify and exact-ID access to Georgia's NAPR parcel lookup exposed by the MSDA viewer.
// It deliberately has no area-query capability: a clicked parcel never proves a viewport complete.
import { booleanPointInPolygon, feature as turfFeature, point as turfPoint } from '@turf/turf';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateGeometry } from './source-contract.js';
import { parseKeralaWktPolygon } from './kerala-source.js';

const SOURCE_ID = 'ge-msda-napr-registered-land-plots';
const ENDPOINT = 'https://ms.gov.ge/core-api/v1/search';
const ID_PREFIX = 'GE-NAPR-';
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ID_BATCH_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 12000;
const MAX_ID_BATCH = 80;
const ID_BATCH_TIMEOUT_MS = 60000;

function unsupportedArea() {
    const error = new Error('The MSDA parcel source supports point and exact-ID lookup only; complete area queries are unavailable.');
    error.status = 422;
    error.code = 'parcel-source-area-unsupported';
    return error;
}

function invalidProvider(message) {
    return upstreamError(message, 502, 'parcel-source-unavailable');
}

function nativeCode(value) {
    return typeof value === 'string' && value.length <= 32
        && /^\d{1,8}(?:\.\d{1,8}){1,4}$/.test(value) ? value : null;
}

function parseGeometry(wkt) {
    try {
        const geometry = parseKeralaWktPolygon(wkt);
        if (!validateGeometry(geometry)) throw new Error('invalid polygon geometry');
        return geometry;
    } catch (error) {
        throw invalidProvider(`MSDA returned invalid parcel geometry: ${error.message}`);
    }
}

function sourceFeature(descriptor, record) {
    const code = nativeCode(record?.cadCode);
    if (!code || typeof record.wktShape !== 'string') {
        throw invalidProvider('MSDA returned a parcel without a native cadastral code and polygon.');
    }
    const geometry = parseGeometry(record.wktShape);
    return canonicalParcelFeature(descriptor, {
        type: 'Feature',
        geometry,
        properties: { cadCode: code }
    }, code);
}

async function readJsonBounded(response, maxBytes) {
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
        throw invalidProvider('MSDA response exceeds the configured byte limit.');
    }
    const reader = response.body?.getReader?.();
    if (!reader) throw invalidProvider('MSDA returned no readable response body.');
    const chunks = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) {
                try { await reader.cancel(); } catch { /* response may already be closed */ }
                throw invalidProvider('MSDA response exceeds the configured byte limit.');
            }
            chunks.push(Buffer.from(value));
        }
    } finally {
        try { reader.releaseLock(); } catch { /* ignore closed stream */ }
    }
    let payload;
    try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); }
    catch { throw invalidProvider('MSDA returned invalid JSON.'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw invalidProvider('MSDA returned an invalid response object.');
    }
    return { payload, bytesRead: size };
}

export function createMsdaPointSource(descriptor, {
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = MAX_BYTES
} = {}) {
    const { id, idPrefix, endpoint, idField, parcelNumberField, outFields } = descriptor || {};
    if (descriptor?.adapter !== 'msda-point' || id !== SOURCE_ID || idPrefix !== ID_PREFIX || endpoint !== ENDPOINT
        || idField !== 'cadCode' || parcelNumberField !== 'cadCode'
        || !Array.isArray(outFields) || outFields.length !== 1 || outFields[0] !== 'cadCode'
        || typeof fetchImpl !== 'function'
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000
        || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > MAX_BYTES) {
        throw new Error('Invalid MSDA point parcel source descriptor.');
    }

    const result = (features, extra = {}) => ({
        type: 'FeatureCollection', features, complete: true, queryType: 'point',
        sourceId: id, returnsWGS84: true, ...extra
    });

    async function request(operation, body, { budgetSignal = null, maxBytes = maxResponseBytes } = {}) {
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const signal = budgetSignal ? AbortSignal.any([timeoutSignal, budgetSignal]) : timeoutSignal;
        let response;
        try {
            response = await fetchImpl(`${endpoint}/${operation}`, {
                method: 'POST',
                redirect: 'error',
                signal,
                headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
        } catch (error) {
            if (signal.aborted || ['AbortError', 'TimeoutError'].includes(error?.name)) {
                throw upstreamError('MSDA parcel provider timed out.', 504);
            }
            throw Object.assign(upstreamError('MSDA parcel provider is unavailable.'), { cause: error });
        }
        if (!response.ok) throw providerHttpError(response);
        try { return await readJsonBounded(response, maxBytes); }
        catch (error) {
            if (signal.aborted || ['AbortError', 'TimeoutError'].includes(error?.name)) {
                throw upstreamError('MSDA parcel provider timed out.', 504);
            }
            throw error;
        }
    }

    function parseLayerRecords(payload) {
        if (payload.error !== undefined && payload.error !== null && payload.error !== false && payload.error !== '') {
            throw invalidProvider('MSDA returned an error for the NAPR point lookup.');
        }
        if (!Object.hasOwn(payload, 'naprTchParcel')) throw invalidProvider('MSDA point response omitted the NAPR parcel result.');
        const layer = payload.naprTchParcel;
        if (layer === null) return [];
        if (!layer || typeof layer !== 'object') {
            throw invalidProvider('MSDA point response has an invalid NAPR parcel result.');
        }
        if (layer.error !== undefined && layer.error !== null && layer.error !== false && layer.error !== '') {
            throw invalidProvider('MSDA returned an error for the NAPR point lookup.');
        }
        if (!Array.isArray(layer.layerRecords)) throw invalidProvider('MSDA point response has an invalid NAPR parcel result.');
        return layer.layerRecords;
    }

    async function queryPoint(coordinates) {
        if (!Array.isArray(coordinates) || coordinates.length !== 2
            || !coordinates.every(Number.isFinite)
            || coordinates[0] < -180 || coordinates[0] > 180
            || coordinates[1] < -90 || coordinates[1] > 90) {
            const error = new Error('Expected a WGS84 point as [longitude, latitude].');
            error.status = 400;
            error.code = 'invalid-parcel-point';
            throw error;
        }
        const [x, y] = coordinates;
        const { payload } = await request('search-by-xy', { lrIds: [261415], x, y, zoom: 20 });
        const records = parseLayerRecords(payload);
        if (!records.length) return result([], { queryType: 'point', point: [x, y] });

        const containing = new Map();
        for (const record of records) {
            const feature = sourceFeature(descriptor, record);
            let contains;
            try { contains = booleanPointInPolygon(turfPoint([x, y]), turfFeature(feature.geometry)); }
            catch { throw invalidProvider('MSDA parcel geometry could not be checked against the requested point.'); }
            if (!contains) continue;
            const previous = containing.get(feature.id);
            if (previous && JSON.stringify(previous.geometry) !== JSON.stringify(feature.geometry)) {
                throw invalidProvider('MSDA returned conflicting geometries for one cadastral code.');
            }
            containing.set(feature.id, feature);
        }
        if (!containing.size) {
            throw invalidProvider('MSDA returned parcel geometry that does not contain the requested point.');
        }
        if (containing.size > 1) throw invalidProvider('MSDA returned multiple parcels containing the requested point.');
        return result([...containing.values()], { queryType: 'point', point: [x, y] });
    }

    async function queryIds(ids) {
        if (!Array.isArray(ids) || ids.length > MAX_ID_BATCH) {
            const error = new Error(`Expected at most ${MAX_ID_BATCH} canonical MSDA parcel IDs.`);
            error.status = 400;
            error.code = 'invalid-parcel-ids';
            throw error;
        }
        const canonicalIds = [...new Set(ids.map(value => String(value ?? '').trim()).filter(Boolean))];
        if (canonicalIds.some(value => !value.startsWith(idPrefix) || !nativeCode(value.slice(idPrefix.length)))) {
            const error = new Error('MSDA parcel IDs must use the configured source prefix and cadastral code.');
            error.status = 400;
            error.code = 'invalid-parcel-ids';
            throw error;
        }

        const features = [];
        const absentIds = [];
        const budgetSignal = AbortSignal.timeout(ID_BATCH_TIMEOUT_MS);
        let remainingBytes = MAX_ID_BATCH_BYTES;
        for (const parcelId of canonicalIds) {
            const code = parcelId.slice(idPrefix.length);
            const { payload, bytesRead } = await request('unified-search', { searchText: code }, {
                budgetSignal, maxBytes: Math.min(maxResponseBytes, remainingBytes)
            });
            remainingBytes -= bytesRead;
            if (!Object.hasOwn(payload, 'naprSearchResult')) {
                throw invalidProvider('MSDA exact-ID response omitted the NAPR search result.');
            }
            if (payload.error !== undefined && payload.error !== null && payload.error !== false && payload.error !== '') {
                throw invalidProvider('MSDA returned an error for the NAPR exact-ID lookup.');
            }
            const record = payload.naprSearchResult;
            if (record === null) { absentIds.push(parcelId); continue; }
            if (!record || typeof record !== 'object' || Array.isArray(record)) {
                throw invalidProvider('MSDA exact-ID response has an invalid NAPR search result.');
            }
            if (record.error !== undefined && record.error !== null && record.error !== false && record.error !== '') {
                throw invalidProvider('MSDA returned an error for the NAPR exact-ID lookup.');
            }
            if (nativeCode(record.cadCode) !== code) {
                throw invalidProvider('MSDA exact-ID response did not match the requested cadastral code.');
            }
            const feature = sourceFeature(descriptor, record);
            if (feature.id !== parcelId) throw invalidProvider('MSDA exact-ID response produced an inconsistent parcel ID.');
            features.push(feature);
        }
        return {
            type: 'FeatureCollection', features, complete: true, queryType: 'ids', sourceId: id,
            returnsWGS84: true, absentIds
        };
    }

    return Object.freeze({
        queryPoint,
        queryIds,
        queryBounds: async () => { throw unsupportedArea(); },
        queryGeometry: async () => { throw unsupportedArea(); }
    });
}
