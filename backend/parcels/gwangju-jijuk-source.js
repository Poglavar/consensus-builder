// Official Jeonnam-Gwangju Jijuk area/PNU lookup; preserve all native rings and parts.
import proj4 from 'proj4';
import { bbox, booleanIntersects, feature as turfFeature } from '@turf/turf';
import { concatBytes } from './byte-utils.js';
import { parseUldkPolygonWkt } from './pl-uldk-point-source.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';

export const GWANGJU_AREA_ENDPOINT = 'https://map.jeonnam-gwangju.go.kr/map/getJijukByArea';
export const GWANGJU_PNU_ENDPOINT = 'https://map.jeonnam-gwangju.go.kr/map/getJijukByPnu';
export const GWANGJU_PROJECTION = '+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs';
const PREFIX = 'KR-JG-JIJUK-PNU-';
const PNU = /^[0-9]{19}$/;
const badQuery = () => Object.assign(new Error('Invalid Jijuk parcel query.'), { status: 400 });

export function createGwangjuJijukParcelSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    const maxBytes = descriptor.maxResponseBytes ?? 4 * 1024 * 1024;
    const maxFeatures = descriptor.maxFeatures ?? 2000;
    const maxKm2 = descriptor.maxBboxKm2 ?? 0.25;
    if (descriptor.id !== 'kr-jeonnam-gwangju-jijuk-lookup' || descriptor.adapter !== 'gwangju-jijuk'
        || descriptor.endpoint !== GWANGJU_AREA_ENDPOINT || descriptor.exactEndpoint !== GWANGJU_PNU_ENDPOINT
        || descriptor.idPrefix !== PREFIX || descriptor.sourceCrs !== 'EPSG:5186'
        || descriptor.idField !== 'pnu' || descriptor.outFields?.length !== 1 || descriptor.outFields[0] !== 'pnu'
        || typeof fetchImpl !== 'function' || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 16 * 1024 * 1024
        || !Number.isSafeInteger(maxFeatures) || maxFeatures < 1 || maxFeatures > 2000
        || !Number.isFinite(maxKm2) || maxKm2 <= 0 || maxKm2 > 0.25) throw new Error('Invalid Jijuk source descriptor.');
    const projection = proj4(GWANGJU_PROJECTION, 'EPSG:4326');
    const result = (features, extra = {}) => ({ type: 'FeatureCollection', features, sourceId: descriptor.id,
        returnsWGS84: true, complete: true, areaComplete: false, authoritativeAbsence: false, ...extra });

    async function post(url, data, options) {
        const timeout = AbortSignal.timeout(30000);
        const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
        const response = await fetchImpl(url, { method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', signal,
            headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(data).toString() });
        if (!response.ok) throw providerHttpError(response);
        if (Number(response.headers.get('content-length')) > maxBytes) {
            await response.body?.cancel();
            throw upstreamError('Jijuk response exceeds the byte limit.');
        }
        const reader = response.body?.getReader();
        if (!reader) throw upstreamError('Jijuk response has no readable body.');
        const chunks = [];
        let bytes = 0;
        try {
            for (;;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                bytes += chunk.value.byteLength;
                if (bytes > maxBytes) throw upstreamError('Jijuk response exceeds the byte limit.');
                chunks.push(chunk.value);
            }
            return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(concatBytes(chunks, bytes)));
        } catch (error) { await reader.cancel().catch(() => {}); throw error; }
        finally { reader.releaseLock(); }
    }

    function parcel(row) {
        // The provider has a fixed response schema. Immediately discard all incidental attributes.
        if (typeof row?.pnu !== 'string' || !PNU.test(row.pnu)
            || typeof row.geom !== 'string' || row.geom.length > 1000000) throw upstreamError('Jijuk returned an invalid parcel.');
        const native = parseUldkPolygonWkt(row.geom.trim());
        const convert = values => typeof values[0] === 'number' ? projection.forward(values) : values.map(convert);
        const geometry = { type: native.type, coordinates: convert(native.coordinates) };
        if (!validateGeometry(geometry)) throw upstreamError('Jijuk returned unusable parcel geometry; no repair applied.');
        return canonicalParcelFeature(descriptor, { geometry, properties: { pnu: row.pnu } }, row.pnu);
    }

    async function queryIds(ids, options = {}) {
        if (!Array.isArray(ids) || ids.length > 80 || new Set(ids).size !== ids.length
            || ids.some(id => typeof id !== 'string' || !id.startsWith(PREFIX) || !PNU.test(id.slice(PREFIX.length)))) throw badQuery();
        const features = [], unresolvedIds = [];
        const budget = AbortSignal.timeout(120000);
        const signal = options.signal ? AbortSignal.any([options.signal, budget]) : budget;
        for (const id of ids) {
            // Always an independent provider read, including after spatial lookup.
            const row = await post(GWANGJU_PNU_ENDPOINT, { code: id.slice(PREFIX.length) }, { signal });
            if (row === null) { unresolvedIds.push(id); continue; }
            const feature = parcel(row);
            if (feature.id !== id) throw upstreamError('Jijuk exact lookup returned a different PNU.');
            features.push(feature);
        }
        return result(features, { complete: !unresolvedIds.length, absentIds: [], unresolvedIds });
    }

    async function queryBounds(bounds, options = {}) {
        validateBounds(bounds, maxKm2);
        const [w, s, e, n] = bounds;
        const points = [[w,s],[e,s],[e,n],[w,n],[w,s]].map(point => projection.inverse(point));
        const wkt = `POLYGON((${points.map(point => point.join(' ')).join(',')}))`;
        const rows = await post(GWANGJU_AREA_ENDPOINT, { wkt }, options);
        if (!Array.isArray(rows) || rows.length >= maxFeatures) throw upstreamError('Jijuk area response is invalid or reached the local transfer cap.');
        const features = rows.map(parcel);
        // Neither conflicting nor identical duplicate source rows may disappear silently.
        if (new Set(features.map(feature => feature.id)).size !== features.length) throw upstreamError('Jijuk area response has duplicate PNU rows.');
        return result(features);
    }

    async function queryGeometry(geometry, options = {}) {
        if (!validateGeometry(geometry)) throw badQuery();
        const read = await queryBounds(bbox(turfFeature(geometry)), options);
        return { ...read, features: read.features.filter(row => booleanIntersects(turfFeature(row.geometry), turfFeature(geometry))) };
    }
    return Object.freeze({ queryIds, queryBounds, queryGeometry });
}
