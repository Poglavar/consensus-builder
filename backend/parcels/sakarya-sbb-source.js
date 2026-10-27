// Live, bounded SBB cadastral reads. A configured native-ID subset is not an area inventory.
import { bbox, bboxPolygon, booleanIntersects, booleanPointInPolygon, feature, point } from '@turf/turf';
import { concatBytes } from './byte-utils.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';

export const SAKARYA_SOURCE = 'tr-sakarya-sbbpublicapi-kentrehberi-parcels';
export const SAKARYA_ENDPOINT = 'https://sbbpublicapi.sakarya.bel.tr/api/v1/CityGuide/Zoning/GetParcelNumberDetail';
export const SAKARYA_ORIGIN = 'https://rehber.sakarya.bel.tr';
export const SAKARYA_VIEWER = `${SAKARYA_ORIGIN}/harita/imar`;
const PREFIX = 'TR-SBB-';
const MAX_BYTES = 1024 * 1024;
const nativeId = id => typeof id === 'string' && /^[1-9]\d{0,14}$/.test(id) && Number.isSafeInteger(Number(id));
const invalid = () => upstreamError('SBB returned an unusable cadastral parcel or changed its native identity.');

export function isSakaryaSource(d) {
    return d?.id === SAKARYA_SOURCE && d.adapter === 'sakarya-sbb-bounded' && d.endpoint === SAKARYA_ENDPOINT;
}

// Permit only the exact public parcel-detail operation and configured native IDs.
export function isSakaryaRequest(d, url, method, body) {
    if (!isSakaryaSource(d) || String(url) !== SAKARYA_ENDPOINT || method !== 'POST' || typeof body !== 'string') return false;
    try {
        const value = JSON.parse(body);
        return value && Object.keys(value).length === 1 && Number.isSafeInteger(value.id)
            && d.coverage?.nativeIds?.includes(String(value.id));
    } catch { return false; }
}

export function createSakaryaSbbSource(descriptor, { fetchImpl = globalThis.fetch, timeoutMs = 15000,
    maxResponseBytes = descriptor.maxResponseBytes ?? MAX_BYTES } = {}) {
    const ids = descriptor.coverage?.nativeIds;
    if (!isSakaryaSource(descriptor) || descriptor.idPrefix !== PREFIX || descriptor.idField !== 'id'
        || descriptor.outFields?.length !== 1 || descriptor.outFields[0] !== 'id'
        || descriptor.capabilities?.areaEnumeration !== false || descriptor.coverage?.citywide !== false
        || descriptor.coverage?.scope !== 'explicit-native-id-subset'
        || !Array.isArray(ids) || !ids.length || ids.length > 3 || ids.some(id => !nativeId(id))
        || new Set(ids).size !== ids.length || typeof fetchImpl !== 'function'
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 45000
        || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > MAX_BYTES) {
        throw new Error('Invalid bounded Sakarya SBB parcel descriptor.');
    }
    async function read(id, signal) {
        const timeout = AbortSignal.timeout(timeoutMs);
        const response = await fetchImpl(SAKARYA_ENDPOINT, { method: 'POST', redirect: 'error', credentials: 'omit',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json',
                Origin: SAKARYA_ORIGIN, Referer: SAKARYA_VIEWER },
            body: JSON.stringify({ id: Number(id) }), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
        if (!response.ok) { await response.body?.cancel(); throw providerHttpError(response); }
        if (!/^application\/json\b/i.test(response.headers.get('content-type') || '')) {
            await response.body?.cancel(); throw invalid();
        }
        const reader = response.body?.getReader();
        if (!reader) throw invalid();
        const chunks = []; let size = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > maxResponseBytes) { await reader.cancel(); throw invalid(); }
                chunks.push(value);
            }
        } finally { reader.releaseLock(); }
        let row;
        try { row = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(concatBytes(chunks, size))); }
        catch { throw invalid(); }
        if ((!Number.isSafeInteger(row?.id) && !nativeId(row?.id)) || String(row.id) !== id
            || !validateGeometry(row.geometry) || row.statusParameter !== 'AKTİF') throw invalid();
        // Discard incidental provider attributes; preserve every geometry coordinate unchanged.
        return canonicalParcelFeature(descriptor, { type: 'Feature', geometry: row.geometry, properties: { id } }, id);
    }
    const result = (features, queryType, extra = {}) => ({ type: 'FeatureCollection', sourceId: descriptor.id,
        features, complete: true, returnsWGS84: true, queryType, coverageScope: 'explicit-native-id-subset',
        areaComplete: false, areaCompleteness: false, authoritativeAbsence: false, scopeComplete: true, ...extra });
    async function queryIds(canonicalIds, { signal } = {}) {
        if (!Array.isArray(canonicalIds) || canonicalIds.length > 80 || canonicalIds.some(id => typeof id !== 'string'
            || !ids.some(native => id === PREFIX + native))) {
            throw upstreamError('Parcel ID is outside the configured SBB subset.', 422, 'parcel-source-out-of-scope');
        }
        const features = [];
        for (const id of new Set(canonicalIds)) features.push(await read(id.slice(PREFIX.length), signal));
        return result(features, 'ids', { absentIds: [] });
    }
    // Only viewport queries share a short in-memory read; exact-ID queries always go upstream.
    let spatial, spatialAt = 0;
    function spatialRead(signal) {
        if (!spatial || Date.now() - spatialAt >= 30000) {
            spatialAt = Date.now();
            spatial = queryIds(ids.map(id => PREFIX + id), { signal }).catch(error => { spatial = null; throw error; });
        }
        return spatial;
    }
    async function queryBounds(bounds, { signal } = {}) {
        validateBounds(bounds, 25);
        const rows = await spatialRead(signal);
        return result(rows.features.filter(row => booleanIntersects(feature(row.geometry), bboxPolygon(bounds))), 'bounds');
    }
    async function queryGeometry(geometry, options) {
        if (!validateGeometry(geometry)) throw new Error('Expected a WGS84 polygon.');
        const rows = await queryBounds(bbox(feature(geometry)), options);
        return result(rows.features.filter(row => booleanIntersects(feature(row.geometry), feature(geometry))), 'geometry');
    }
    async function queryPoint(position, { signal } = {}) {
        if (!Array.isArray(position) || position.length !== 2 || !position.every(Number.isFinite)
            || Math.abs(position[0]) > 180 || Math.abs(position[1]) > 90) throw new Error('Expected a WGS84 point.');
        const rows = await spatialRead(signal);
        return result(rows.features.filter(row => booleanPointInPolygon(point(position), feature(row.geometry))), 'point');
    }
    return Object.freeze({ queryIds, queryBounds, queryGeometry, queryPoint });
}
