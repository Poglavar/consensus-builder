// Read an explicitly bounded subset of the Tatarstan historic cadastral layer live.
// Reconfirm the native cadastral number before every externalId geometry read.
import proj4 from 'proj4';
import { bbox, bboxPolygon, booleanIntersects, booleanPointInPolygon, feature, point } from '@turf/turf';
import { concatBytes } from './byte-utils.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';

export const TATARSTAN_SOURCE = 'ru-tatarstan-karta-cadastre';
export const TATARSTAN_ENDPOINT = 'https://karta.tatar.ru/gis/ajax/info';
export const TATARSTAN_GEOMETRY = 'https://karta.tatar.ru/GIS/AJAX/CadastreGeom';
const PREFIX = 'RU-TATARSTAN-';
const MAX_BYTES = 2 * 1024 * 1024;
const validPoint = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)
    && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 85;
const invalid = () => upstreamError('Tatarstan cadastral response is unusable or its native identity changed.');

export function isTatarstanSource(d) {
    return d?.id === TATARSTAN_SOURCE && d.adapter === 'tatarstan-cadastre-bounded'
        && d.endpoint === TATARSTAN_ENDPOINT && d.geometryEndpoint === TATARSTAN_GEOMETRY;
}

export function tatarstanPointUrl(position) {
    const [x, y] = proj4('EPSG:4326', 'EPSG:3857', position);
    const url = new URL(TATARSTAN_ENDPOINT);
    url.search = new URLSearchParams({ lon: String(x), lat: String(y), section: '4' }).toString();
    return url.href;
}

// The browser relay exposes only the configured anonymous anchor and geometry reads.
export function isTatarstanRequest(d, target, method = 'GET', body) {
    if (!isTatarstanSource(d) || method !== 'GET' || body != null) return false;
    return (d.coverage?.parcels || []).some(row => String(target) === tatarstanPointUrl(row.point)
        || String(target) === `${TATARSTAN_GEOMETRY}?id=${encodeURIComponent(row.externalId)}`);
}

export function tatarstanGeometry(raw) {
    if (!['Polygon', 'MultiPolygon'].includes(raw?.type) || raw.crs?.type !== 'name'
        || raw.crs.properties?.name !== 'spatialreferencing.org:900913') throw invalid();
    const rings = polygon => polygon.map(ring => ring.map(pair => {
        if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(Number.isFinite)
            || pair.some(value => Math.abs(value) > 20037509)) throw invalid();
        return proj4('EPSG:3857', 'EPSG:4326', pair);
    }));
    let geometry;
    try {
        // Only transform vertices; preserve every ring, hole, part and coordinate precision.
        geometry = { type: raw.type, coordinates: raw.type === 'Polygon'
            ? rings(raw.coordinates) : raw.coordinates.map(rings) };
    } catch { throw invalid(); }
    if (!validateGeometry(geometry)) throw invalid();
    return geometry;
}

export function createTatarstanCadastreSource(descriptor, { fetchImpl = globalThis.fetch,
    timeoutMs = 30000, maxResponseBytes = descriptor.maxResponseBytes ?? MAX_BYTES } = {}) {
    const rows = descriptor.coverage?.parcels;
    if (!isTatarstanSource(descriptor) || descriptor.idPrefix !== PREFIX || descriptor.idField !== 'cad_num'
        || descriptor.outFields?.length !== 1 || descriptor.outFields[0] !== 'cad_num'
        || descriptor.nativeCrs !== 'EPSG:3857' || descriptor.capabilities?.areaEnumeration !== false
        || descriptor.coverage?.scope !== 'explicit-native-id-subset' || descriptor.coverage?.citywide !== false
        || !Array.isArray(rows) || rows.length < 1 || rows.length > 3
        || new Set(rows.map(row => row.id)).size !== rows.length
        || new Set(rows.map(row => row.externalId)).size !== rows.length
        || rows.some(row => !/^16:\d{2}:\d{6,7}:\d+(?:\(\d+\))?$/.test(row.id)
            || !/^[1-9]\d{0,9}$/.test(row.externalId) || !validPoint(row.point))
        || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > MAX_BYTES
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 45000) {
        throw new Error('Invalid bounded Tatarstan cadastral descriptor.');
    }
    async function request(url, signal) {
        const timeout = AbortSignal.timeout(timeoutMs);
        const response = await fetchImpl(url, { method: 'GET', redirect: 'error', credentials: 'omit',
            headers: { Accept: 'application/json' }, signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
        if (!response.ok) { await response.body?.cancel(); throw providerHttpError(response); }
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
        try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(concatBytes(chunks, size))); }
        catch { throw invalid(); }
    }
    async function read(row, signal) {
        const info = await request(tatarstanPointUrl(row.point), signal);
        // Discard the provider's incidental fields immediately. No raw attributes escape.
        const matches = info?.['4']?.cadastre;
        if (!Array.isArray(matches) || matches.length > 100) throw invalid();
        const identities = matches.map(record => ({ id: record.cad_num, externalId: record.externalId }));
        const matching = identities.filter(record => record.id === row.id);
        if (matching.length !== 1 || String(matching[0].externalId) !== row.externalId) throw invalid();
        const raw = await request(`${TATARSTAN_GEOMETRY}?id=${encodeURIComponent(row.externalId)}`, signal);
        const geometry = tatarstanGeometry(raw);
        if (!booleanPointInPolygon(point(row.point), feature(geometry))) throw invalid();
        return canonicalParcelFeature(descriptor, { type: 'Feature', properties: { cad_num: row.id }, geometry }, row.id);
    }
    const result = (features, queryType, extra = {}) => ({ type: 'FeatureCollection', sourceId: descriptor.id,
        features, complete: true, returnsWGS84: true, queryType, coverageScope: 'explicit-native-id-subset',
        areaCompleteness: false, areaComplete: false, authoritativeAbsence: false, scopeComplete: true, ...extra });
    async function queryIds(ids, { signal } = {}) {
        if (!Array.isArray(ids) || ids.length > 80 || ids.some(id => typeof id !== 'string'
            || !rows.some(row => id === PREFIX + row.id))) {
            throw upstreamError('Parcel ID is outside the configured Tatarstan subset.', 422, 'parcel-source-out-of-scope');
        }
        const features = [];
        for (const id of new Set(ids)) features.push(await read(rows.find(row => PREFIX + row.id === id), signal));
        return result(features, 'ids', { absentIds: [] });
    }
    // Viewport cells share one short live read; exact-ID reads always return to the provider.
    let spatial, spatialAt = 0;
    function spatialRead(signal) {
        if (!spatial || Date.now() - spatialAt >= 30000) {
            spatialAt = Date.now();
            spatial = queryIds(rows.map(row => PREFIX + row.id), { signal }).catch(error => { spatial = null; throw error; });
        }
        return spatial;
    }
    async function queryBounds(bounds, { signal } = {}) {
        validateBounds(bounds, 25);
        const read = await spatialRead(signal);
        return result(read.features.filter(row => booleanIntersects(feature(row.geometry), bboxPolygon(bounds))), 'bounds');
    }
    async function queryGeometry(geometry, options) {
        if (!validateGeometry(geometry)) throw new Error('Expected WGS84 polygon.');
        const read = await queryBounds(bbox(feature(geometry)), options);
        return result(read.features.filter(row => booleanIntersects(feature(row.geometry), feature(geometry))), 'geometry');
    }
    async function queryPoint(position, { signal } = {}) {
        if (!validPoint(position)) throw new Error('Expected WGS84 [longitude, latitude].');
        const read = await spatialRead(signal);
        return result(read.features.filter(row => booleanPointInPolygon(point(position), feature(row.geometry))), 'point');
    }
    return Object.freeze({ queryIds, queryBounds, queryGeometry, queryPoint });
}
