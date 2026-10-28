// Read a declared finite set of public EGRN parcel IDs live, without implying citywide coverage.
import proj4 from 'proj4';
import { bbox, bboxPolygon, booleanIntersects, booleanPointInPolygon, feature, point } from '@turf/turf';
import { concatBytes } from './byte-utils.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';

export const REESTR54_SOURCE = 'ru-altai-reestr54-barnaul-cadastral';
export const REESTR54_ENDPOINT = 'https://kk.reestr54.ru/barnaul/';
const CITY_SOURCES = Object.freeze({
    'ru-belgorod-reestr54-cadastral': { endpoint: 'https://kk.reestr54.ru/belgorod/', prefix: 'RU-REESTR54-BELGOROD-', nativeId: /^31:(?:15|16):\d{6,7}:\d+$/ },
    'ru-tula-reestr54-cadastral': { endpoint: 'https://kk.reestr54.ru/tula/', prefix: 'RU-REESTR54-TULA-', nativeId: /^71:30:\d{6,7}:\d+$/ },
    'ru-tver-reestr54-tver-cadastral': { endpoint: 'https://kk.reestr54.ru/tver/', prefix: 'RU-REESTR54-TVER-', nativeId: /^69:40:\d{6,7}:\d+$/ },
    'ru-stavropol-reestr54-cadastral-map': { endpoint: 'https://kk.reestr54.ru/stavropol/', prefix: 'RU-REESTR54-STAVROPOL-', nativeId: /^26:(?:11|12):\d{6,7}:\d+$/ },
    'ru-mosobl-reestr54-cadastral': { endpoint: 'https://kk.reestr54.ru/moskovskaya-oblast/', prefix: 'RU-REESTR54-PODOLSK-', nativeId: /^50:(?:55|27):\d{6,7}:\d+$/ },
    [REESTR54_SOURCE]: { endpoint: REESTR54_ENDPOINT, prefix: 'RU-REESTR54-BARNAUL-', nativeId: /^22:63:\d{6,7}:\d+$/ },
    'ru-orenburg-reestr54-public-cadastre': { endpoint: 'https://kk.reestr54.ru/orenburgskaya-oblast/', prefix: 'RU-REESTR54-ORENBURG-', nativeId: /^56:44:\d{6,7}:\d+$/ },
    'ru-chuvashia-reestr54-cheboksary-cadastral': { endpoint: 'https://kk.reestr54.ru/chuvashskaya-respublika/', prefix: 'RU-REESTR54-CHEBOKSARY-', nativeId: /^21:01:\d{6,7}:\d+$/ },
    'ru-tomsk-reestr54-cadastral': { endpoint: 'https://kk.reestr54.ru/tomsk/', prefix: 'RU-REESTR54-TOMSK-', nativeId: /^70:21:\d{6,7}:\d+$/ },
    'ru-ulyanovsk-reestr54-cadastral': { endpoint: 'https://kk.reestr54.ru/ulyanovskaya-oblast/', prefix: 'RU-REESTR54-ULYANOVSK-', nativeId: /^73:24:\d{6,7}:\d+$/ },
    'ru-reestr54-kaliningrad-cadastral': { endpoint: 'https://kk.reestr54.ru/kaliningrad/', prefix: 'RU-REESTR54-KALININGRAD-', nativeId: /^39:15:\d{6,7}:\d+$/ }
});
const MAX_BYTES = 2 * 1024 * 1024;
const invalid = () => upstreamError('Public cadastral map returned an unusable parcel response.');

export function isReestr54Source(d) {
    return Object.hasOwn(CITY_SOURCES, d?.id) && d.adapter === 'reestr54-bounded'
        && d.endpoint === CITY_SOURCES[d.id].endpoint;
}

// The relay accepts only anonymous page bootstrap or exact-ID reads within the published app scope.
export function isReestr54Request(d, target, method, body) {
    if (!isReestr54Source(d) || String(target) !== d.endpoint) return false;
    if (method === 'GET') return body === undefined || body === null;
    if (method !== 'POST' || typeof body !== 'string') return false;
    try {
        const value = JSON.parse(body);
        return value && Object.keys(value).length === 2 && value.zoom === 19
            && typeof value.new_kadnum === 'string' && d.coverage?.nativeIds?.includes(value.new_kadnum);
    } catch { return false; }
}

export function reestr54Feature(d, row, expectedId) {
    if (row?.type !== 'Feature' || row.properties?.category !== 36368
        || (row.realty_type !== undefined && row.realty_type !== 'Земельный участок')
        || row.properties?.options?.cad_num !== expectedId || !CITY_SOURCES[d.id]?.nativeId.test(expectedId)
        || !['Polygon', 'MultiPolygon'].includes(row.geometry?.type)) throw invalid();
    const rings = polygon => polygon.map(ring => ring.map(pair => {
        if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(Number.isFinite)
            || Math.abs(pair[0]) > 20037509 || Math.abs(pair[1]) > 20037509) throw invalid();
        return proj4('EPSG:3857', 'EPSG:4326', pair);
    }));
    // Transform vertices only: no rounding, repair, clipping, ring changes, or fitted offsets.
    let geometry;
    try {
        geometry = { type: row.geometry.type, coordinates: row.geometry.type === 'Polygon'
            ? rings(row.geometry.coordinates) : row.geometry.coordinates.map(rings) };
    } catch { throw invalid(); }
    if (!validateGeometry(geometry)) throw invalid();
    return canonicalParcelFeature(d, { type: 'Feature', properties: { cad_num: expectedId }, geometry }, expectedId);
}

export function createReestr54Source(descriptor, { fetchImpl = globalThis.fetch, timeoutMs = 30000,
    maxResponseBytes = descriptor.maxResponseBytes ?? MAX_BYTES } = {}) {
    const ids = descriptor.coverage?.nativeIds;
    if (!isReestr54Source(descriptor) || descriptor.idPrefix !== CITY_SOURCES[descriptor.id].prefix
        || descriptor.idField !== 'cad_num' || descriptor.outFields?.length !== 1 || descriptor.outFields[0] !== 'cad_num'
        || descriptor.nativeCrs !== 'EPSG:3857' || descriptor.capabilities?.areaEnumeration !== false
        || descriptor.coverage?.scope !== 'explicit-native-id-subset' || descriptor.coverage?.citywide !== false
        || !Array.isArray(ids) || !ids.length || ids.length > 3 || new Set(ids).size !== ids.length
        || ids.some(id => typeof id !== 'string' || !CITY_SOURCES[descriptor.id].nativeId.test(id))
        || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > MAX_BYTES
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 45000) {
        throw new Error('Invalid bounded reestr54 descriptor.');
    }
    let session;
    async function request(method, token, nativeId, signal) {
        const timeout = AbortSignal.timeout(timeoutMs);
        const response = await fetchImpl(descriptor.endpoint, { method, credentials: 'omit', redirect: 'error',
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
            headers: { Accept: method === 'GET' ? 'text/html' : 'application/json',
                ...(token ? { Referer: descriptor.endpoint, Cookie: `csrftoken=${token}`, 'X-CSRFToken': token,
                    'Content-Type': 'application/json' } : {}) },
            ...(method === 'POST' ? { body: JSON.stringify({ new_kadnum: nativeId, zoom: 19 }) } : {}) });
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
        const text = new TextDecoder('utf-8', { fatal: true }).decode(concatBytes(chunks, size));
        if (method === 'GET') {
            const cookies = response.headers.getSetCookie?.() || [response.headers.get('set-cookie') || ''];
            const csrf = cookies.map(value => /(?:^|,\s*)csrftoken=([A-Za-z0-9]{32,64})(?:;|$)/.exec(value)?.[1]).find(Boolean);
            if (!csrf || !text.includes('Публичная кадастровая карта')) throw invalid();
            return csrf;
        }
        if (!/^application\/json\b/i.test(response.headers.get('content-type') || '')) throw invalid();
        let row;
        try { row = JSON.parse(text); } catch { throw invalid(); }
        // The provider conflates no-object with upstream outage; never convert it to explicit absence.
        return reestr54Feature(descriptor, row, nativeId);
    }
    async function read(id, signal) {
        session ||= request('GET', null, null, signal).catch(error => { session = null; throw error; });
        try { return await request('POST', await session, id, signal); }
        catch (error) { if (error.upstreamStatus === 403) session = null; throw error; }
    }
    const result = (features, queryType, extra = {}) => ({ type: 'FeatureCollection', sourceId: descriptor.id,
        features, complete: true, returnsWGS84: true, queryType, coverageScope: 'explicit-native-id-subset',
        areaCompleteness: false, areaComplete: false, authoritativeAbsence: false, scopeComplete: true, ...extra });
    async function queryIds(canonicalIds, { signal } = {}) {
        if (!Array.isArray(canonicalIds) || canonicalIds.length > 80 || canonicalIds.some(id => typeof id !== 'string'
            || !id.startsWith(descriptor.idPrefix) || !ids.includes(id.slice(descriptor.idPrefix.length)))) {
            throw upstreamError('Parcel ID is outside the explicitly configured cadastral subset.', 422, 'parcel-source-out-of-scope');
        }
        const features = [];
        for (const id of new Set(canonicalIds)) features.push(await read(id.slice(descriptor.idPrefix.length), signal));
        return result(features, 'ids', { absentIds: [] });
    }
    // Adjacent viewport cells share a short in-memory read. Exact-ID calls always read upstream.
    let spatial, spatialAt = 0;
    function spatialRead(signal) {
        if (!spatial || Date.now() - spatialAt >= 30000) {
            spatialAt = Date.now();
            spatial = queryIds(ids.map(id => descriptor.idPrefix + id), { signal }).catch(error => { spatial = null; throw error; });
        }
        return spatial;
    }
    async function queryBounds(bounds, { signal } = {}) {
        validateBounds(bounds, 25);
        const rows = await spatialRead(signal);
        return result(rows.features.filter(row => booleanIntersects(feature(row.geometry), bboxPolygon(bounds))), 'bounds');
    }
    async function queryGeometry(geometry, options) {
        if (!validateGeometry(geometry)) throw new Error('Expected WGS84 polygon.');
        const rows = await queryBounds(bbox(feature(geometry)), options);
        return result(rows.features.filter(row => booleanIntersects(feature(row.geometry), feature(geometry))), 'geometry');
    }
    async function queryPoint(position, { signal } = {}) {
        if (!Array.isArray(position) || position.length !== 2 || !position.every(Number.isFinite)
            || Math.abs(position[0]) > 180 || Math.abs(position[1]) > 90) throw new Error('Expected WGS84 point.');
        const rows = await spatialRead(signal);
        return result(rows.features.filter(row => booleanPointInPolygon(point(position), feature(row.geometry))), 'point');
    }
    return Object.freeze({ queryIds, queryBounds, queryGeometry, queryPoint });
}
