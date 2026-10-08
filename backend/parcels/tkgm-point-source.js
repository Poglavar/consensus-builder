// TKGM MEGSİS point-identify and exact-ID lookup. The public viewer exposes one selected
// parcel at a time; this adapter deliberately does not claim complete area coverage.
import { booleanPointInPolygon, feature as turfFeature, point as turfPoint } from '@turf/turf';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateGeometry } from './source-contract.js';

const SOURCE_ID = 'tr-tkgm-parselsorgu-api';
const ENDPOINT = 'https://cbsapi.tkgm.gov.tr/megsiswebapi.v3.1/api/parsel';
const ID_PREFIX = 'TR-TKGM-';
const ID_FIELDS = ['mahalleId', 'adaNo', 'parselNo'];
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_BATCH_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 12000;
const BATCH_TIMEOUT_MS = 60000;
const MAX_ID_BATCH = 80;

function unsupportedArea() {
    const error = new Error('TKGM parcel search supports point and exact-ID lookup only; complete area queries are unavailable.');
    error.status = 422;
    error.code = 'parcel-source-area-unsupported';
    return error;
}

function invalidProvider(message) {
    return upstreamError(message, 502, 'parcel-source-unavailable');
}

function invalidPoint() {
    const error = new Error('Expected a finite WGS84 point as [longitude, latitude].');
    error.status = 400;
    error.code = 'invalid-parcel-point';
    return error;
}

function invalidIds() {
    const error = new Error('Expected canonical TKGM parcel IDs using the configured source prefix.');
    error.status = 400;
    error.code = 'invalid-parcel-ids';
    return error;
}

function idPart(value) {
    if (typeof value === 'string' && /^\d{1,20}$/.test(value)) return value;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
    return null;
}

function nativeParts(properties) {
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return null;
    const parts = ID_FIELDS.map(field => idPart(properties[field]));
    return parts.every(Boolean) ? parts : null;
}

function nativeIdFromParts(parts) { return parts.join('-'); }

function exactNotFoundMessage(message, parts) {
    if (typeof message !== 'string') return false;
    const [mahalleId, adaNo, parselNo] = parts;
    return normalizeMessage(message) === normalizeMessage(
        `Parsel Bulunamadı: Mahalle Id = ${mahalleId} - Ada = ${adaNo} - Parsel = ${parselNo}`
    );
}

function pointNotFoundMessage(message, latitude, longitude) {
    if (typeof message !== 'string') return false;
    return normalizeMessage(message) === normalizeMessage(`Parsel Bulunamadı: Enlem = ${latitude} - Boylam = ${longitude}`);
}

function normalizeMessage(message) {
    return message.normalize('NFKC').replace(/\s+/g, ' ').replace(/\s*=\s*/g, '=').trim().toLocaleLowerCase('tr-TR');
}

function parseExactId(value, idPrefix) {
    if (typeof value !== 'string' || !value.startsWith(idPrefix)) return null;
    const nativeId = value.slice(idPrefix.length);
    const parts = nativeId.split('-');
    return parts.length === 3 && parts.every(part => /^\d{1,20}$/.test(part))
        ? { id: value, nativeId, parts } : null;
}

function validateDescriptor(descriptor, { fetchImpl, timeoutMs, maxResponseBytes }) {
    const { id, idPrefix, endpoint, idField, parcelNumberField, outFields } = descriptor || {};
    if (descriptor?.adapter !== 'tkgm-point' || id !== SOURCE_ID || idPrefix !== ID_PREFIX || endpoint !== ENDPOINT
        || idField !== 'nativeId' || parcelNumberField !== 'parselNo'
        || !Array.isArray(outFields) || outFields.length !== ID_FIELDS.length
        || ID_FIELDS.some((field, index) => outFields[index] !== field)
        || typeof fetchImpl !== 'function'
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000
        || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > MAX_BYTES) {
        throw new Error('Invalid TKGM point parcel source descriptor.');
    }
}

async function readJsonBounded(response, maxBytes) {
    const contentLength = response.headers?.get?.('content-length');
    if (typeof contentLength === 'string' && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
        throw invalidProvider('TKGM response exceeds the configured byte limit.');
    }
    const reader = response.body?.getReader?.();
    if (!reader) throw invalidProvider('TKGM returned no readable response body.');
    const chunks = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) {
                try { await reader.cancel(); } catch { /* response may already be closed */ }
                throw invalidProvider('TKGM response exceeds the configured byte limit.');
            }
            chunks.push(Buffer.from(value));
        }
    } finally {
        try { reader.releaseLock(); } catch { /* ignore closed streams */ }
    }
    let payload;
    try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); }
    catch { throw invalidProvider('TKGM returned invalid JSON.'); }
    return { payload, bytesRead: size };
}

export function createTkgmPointSource(descriptor, {
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = MAX_BYTES
} = {}) {
    validateDescriptor(descriptor, { fetchImpl, timeoutMs, maxResponseBytes });
    const { id, idPrefix } = descriptor;

    const result = (features, queryType, extra = {}) => ({
        type: 'FeatureCollection', features, complete: true, queryType,
        sourceId: id, returnsWGS84: true, ...extra
    });

    async function request(path, { budgetSignal = null, maxBytes = maxResponseBytes } = {}) {
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const signal = budgetSignal ? AbortSignal.any([timeoutSignal, budgetSignal]) : timeoutSignal;
        let response;
        try {
            response = await fetchImpl(`${descriptor.endpoint}/${path}`, {
                method: 'GET', redirect: 'error', signal,
                headers: { Accept: 'application/geo+json, application/json' }
            });
        } catch (error) {
            if (signal.aborted || ['AbortError', 'TimeoutError'].includes(error?.name)) {
                throw upstreamError('TKGM parcel provider timed out.', 504);
            }
            throw Object.assign(upstreamError('TKGM parcel provider is unavailable.'), { cause: error });
        }
        // A 404 carries the provider's verified no-hit message, so read that body.
        // Other HTTP errors may be HTML or empty; preserve status metadata first.
        if (!response.ok && response.status !== 404) throw providerHttpError(response);
        try {
            const { payload, bytesRead } = await readJsonBounded(response, maxBytes);
            return { response, payload, bytesRead };
        } catch (error) {
            if (signal.aborted || ['AbortError', 'TimeoutError'].includes(error?.name)) {
                throw upstreamError('TKGM parcel provider timed out.', 504);
            }
            throw error;
        }
    }

    function sourceFeature(payload, expectedParts = null) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)
            || payload.type !== 'Feature' || !validateGeometry(payload.geometry)) {
            throw invalidProvider('TKGM returned an invalid parcel feature or WGS84 polygon.');
        }
        const parts = nativeParts(payload.properties);
        if (!parts) throw invalidProvider('TKGM parcel response omitted its native cadastral identity.');
        if (expectedParts && parts.some((part, index) => part !== expectedParts[index])) {
            throw invalidProvider('TKGM exact-ID response did not match the requested parcel identity.');
        }
        const nativeId = nativeIdFromParts(parts);
        const properties = Object.fromEntries(ID_FIELDS.map(field => [field, parts[ID_FIELDS.indexOf(field)]]));
        return canonicalParcelFeature(descriptor, { type: 'Feature', geometry: payload.geometry, properties }, nativeId);
    }

    async function queryPoint(coordinates) {
        if (!Array.isArray(coordinates) || coordinates.length !== 2
            || !coordinates.every(value => typeof value === 'number' && Number.isFinite(value))
            || coordinates[0] < -180 || coordinates[0] > 180
            || coordinates[1] < -90 || coordinates[1] > 90) throw invalidPoint();
        const [longitude, latitude] = coordinates;
        const { response, payload } = await request(`${latitude}/${longitude}`);
        if (response.status === 404) {
            if (payload && typeof payload === 'object' && !Array.isArray(payload)
                && pointNotFoundMessage(payload.Message, latitude, longitude)) {
                return result([], 'point', { point: [longitude, latitude] });
            }
            throw providerHttpError(response);
        }
        if (!response.ok) throw providerHttpError(response);
        const feature = sourceFeature(payload);
        let contains;
        try { contains = booleanPointInPolygon(turfPoint(coordinates), turfFeature(feature.geometry)); }
        catch { throw invalidProvider('TKGM parcel geometry could not be checked against the requested point.'); }
        if (!contains) throw invalidProvider('TKGM returned parcel geometry that does not contain the requested point.');
        return result([feature], 'point', { point: [longitude, latitude] });
    }

    async function queryIds(ids) {
        if (!Array.isArray(ids) || ids.length > MAX_ID_BATCH) throw invalidIds();
        const canonicalIds = [...new Set(ids)];
        const parsed = canonicalIds.map(value => parseExactId(value, idPrefix));
        if (parsed.some(value => value === null)) throw invalidIds();

        const features = [];
        const absentIds = [];
        const budgetSignal = AbortSignal.timeout(BATCH_TIMEOUT_MS);
        let remainingBytes = MAX_BATCH_BYTES;
        for (const requestId of parsed) {
            if (remainingBytes < 1) throw invalidProvider('TKGM exact-ID response batch exceeds the byte limit.');
            const [mahalleId, adaNo, parselNo] = requestId.parts;
            const { response, payload, bytesRead } = await request(`${mahalleId}/${adaNo}/${parselNo}`, {
                budgetSignal, maxBytes: Math.min(maxResponseBytes, remainingBytes)
            });
            remainingBytes -= bytesRead;
            if (remainingBytes < 0) throw invalidProvider('TKGM exact-ID response batch exceeds the byte limit.');
            if (response.status === 404) {
                if (payload && typeof payload === 'object' && !Array.isArray(payload)
                    && exactNotFoundMessage(payload.Message, requestId.parts)) {
                    absentIds.push(requestId.id);
                    continue;
                }
                throw providerHttpError(response);
            }
            if (!response.ok) throw providerHttpError(response);
            features.push(sourceFeature(payload, requestId.parts));
        }
        return result(features, 'ids', { absentIds });
    }

    return Object.freeze({
        queryPoint,
        queryIds,
        queryBounds: async () => { throw unsupportedArea(); },
        queryGeometry: async () => { throw unsupportedArea(); }
    });
}
