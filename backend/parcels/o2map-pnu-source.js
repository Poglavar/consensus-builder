// Daejeon's municipal O2Map WFS uses CQL, unprefixed types and one-based paging without totals.
import { bbox as geometryBbox, bboxPolygon, booleanIntersects, feature as geoFeature } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { concatBytes } from './byte-utils.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, areaLimitError, validateBounds, validateGeometry } from './source-contract.js';
import { geoJsonResponseCrsMatches } from './response-crs.js';

const ENDPOINT = 'https://gis.daejeon.go.kr/proxy/proxy.jsp?url=o2map/services/wfs';
const PNU = /^[0-9]{19}$/;

export function createO2mapPnuSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    const { id, idPrefix, outFields } = descriptor;
    const pageSize = descriptor.pageSize ?? 200;
    const maxFeatures = descriptor.maxFeatures ?? 5000;
    const maxPages = descriptor.maxPages ?? 100;
    const maxResponseBytes = descriptor.maxResponseBytes ?? 2 * 1024 * 1024;
    const maxBboxKm2 = descriptor.maxBboxKm2 ?? 1;
    const idBatchSize = descriptor.idBatchSize ?? 20;
    // The relay has a 15 s upstream deadline. Leave room for its HTTP 504 to arrive
    // before the browser aborts, then allow one fresh read for a transient dropped request.
    const timeoutMs = descriptor.timeoutMs ?? 20000;
    if (!id || typeof idPrefix !== 'string' || !idPrefix || descriptor.endpoint !== ENDPOINT
        || descriptor.featureType !== 'LSMD_CONT_LDREG_2024' || descriptor.version !== '1.1.0'
        || descriptor.idField !== 'PNU' || descriptor.idType !== 'string' || descriptor.geometryField !== 'THE_GEOM'
        || descriptor.requestProperties !== true || !Array.isArray(outFields)
        || outFields.length !== 1 || outFields[0] !== 'PNU'
        || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000
        || !Number.isSafeInteger(maxFeatures) || maxFeatures < pageSize || maxFeatures > 10000
        || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 200
        || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 8 * 1024 * 1024
        || !Number.isFinite(maxBboxKm2) || maxBboxKm2 <= 0 || maxBboxKm2 > 25
        || !Number.isSafeInteger(idBatchSize) || idBatchSize < 1 || idBatchSize > 80
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) {
        throw new Error('Invalid O2Map PNU source descriptor.');
    }

    async function read(params, limit, options = {}) {
        for (let attempt = 0; ; attempt++) {
            options.signal?.throwIfAborted();
            try { return await readOnce(params, limit, options); }
            catch (error) {
                options.signal?.throwIfAborted();
                if (error.code !== 'o2map-transport-interrupted') throw error;
                if (attempt >= 1) throw upstreamError(error.message, error.status);
            }
        }
    }

    async function readOnce(params, limit, options) {
        const url = new URL(ENDPOINT);
        for (const [key, value] of Object.entries({ service: 'WFS', version: '1.1.0', request: 'GetFeature',
            typeName: descriptor.featureType, outputFormat: 'application/json', srsName: 'EPSG:4326',
            propertyName: 'PNU,THE_GEOM', maxFeatures: String(limit), ...params })) url.searchParams.set(key, value);
        const deadline = AbortSignal.timeout(timeoutMs);
        const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
        let payload;
        try {
            const response = await fetchImpl(url.href, { signal, redirect: 'error', cache: 'no-store', headers: { Accept: 'application/json' } });
            if (!response.ok) {
                // Release the failed response before retrying. Denials, rate limits and
                // other HTTP failures are deliberately not classified as transport retries.
                const error = response.status === 504
                    ? upstreamError('O2Map WFS timed out.', 504, 'o2map-transport-interrupted')
                    : providerHttpError(response);
                await response.body?.cancel().catch(() => {});
                throw error;
            }
            const reader = response.body?.getReader();
            if (!reader) throw upstreamError('O2Map WFS omitted its response body.');
            const chunks = [];
            let bytes = 0;
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    bytes += value.byteLength;
                    if (bytes > maxResponseBytes) throw upstreamError('O2Map WFS exceeded the response byte limit.');
                    chunks.push(value);
                }
                payload = JSON.parse(new TextDecoder().decode(concatBytes(chunks)));
            } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        } catch (error) {
            options.signal?.throwIfAborted();
            if (error.status) throw error;
            if (deadline.aborted || error.name === 'TimeoutError') {
                throw upstreamError('O2Map WFS timed out.', 504, 'o2map-transport-interrupted');
            }
            if (error instanceof TypeError) {
                throw upstreamError('O2Map WFS connection was interrupted.', 502, 'o2map-transport-interrupted');
            }
            throw upstreamError('O2Map WFS returned an unavailable or malformed response.');
        }
        if (payload?.type !== 'FeatureCollection' || !Array.isArray(payload.features)
            || payload.features.length > limit || !geoJsonResponseCrsMatches(payload.crs, 4326)) {
            throw upstreamError('O2Map WFS returned an invalid page or response CRS.');
        }
        const seen = new Set();
        return payload.features.map(feature => {
            const nativeId = feature?.properties?.PNU;
            if (typeof nativeId !== 'string' || !PNU.test(nativeId) || seen.has(nativeId)
                || !validateGeometry(feature.geometry)) throw upstreamError('O2Map WFS returned an invalid or repeated parcel.');
            seen.add(nativeId);
            // Discard any unsolicited properties immediately; keep every source coordinate unchanged.
            return canonicalParcelFeature(descriptor, { geometry: feature.geometry, properties: { PNU: nativeId } }, nativeId);
        });
    }

    const result = features => ({ type: 'FeatureCollection', features, sourceId: id, complete: true, returnsWGS84: true });
    async function queryIds(ids, options = {}) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80) throw new HttpError(400, 'Provide between 1 and 80 parcel IDs.');
        const unique = [...new Set(ids)];
        const native = unique.map(value => {
            if (typeof value !== 'string' || !value.startsWith(idPrefix) || !PNU.test(value.slice(idPrefix.length))) {
                throw new HttpError(400, 'Invalid O2Map parcel ID.');
            }
            return value.slice(idPrefix.length);
        });
        const features = [];
        for (let offset = 0; offset < native.length; offset += idBatchSize) {
            const batch = native.slice(offset, offset + idBatchSize);
            const cql = `PNU IN (${batch.map(value => `'${value}'`).join(',')})`;
            // One extra row exposes ignored filters and duplicate identities instead of hiding them at the cap.
            const page = await read({ CQL: cql }, batch.length + 1, options);
            if (page.some(feature => !batch.includes(feature.properties.sourceParcelId))) {
                throw upstreamError('O2Map WFS ignored the exact-PNU filter.');
            }
            features.push(...page);
        }
        const found = new Set(features.map(feature => feature.id));
        return { ...result(features), absentIds: unique.filter(value => !found.has(value)) };
    }

    async function queryBounds(bbox, options = {}) {
        validateBounds(bbox, maxBboxKm2, descriptor);
        const footprint = bboxPolygon(bbox);
        const features = [], seen = new Set();
        for (let page = 0; page < maxPages; page++) {
            // Live probes establish row 1 as the first row, and row 4 immediately after rows 1–3.
            const rows = await read({ bbox: bbox.join(','), startIndex: String(page * pageSize + 1), sortBy: 'GID+A' }, pageSize, options);
            for (const feature of rows) {
                if (seen.has(feature.id)) throw upstreamError('O2Map WFS repeated a parcel across pages.');
                seen.add(feature.id);
                features.push(feature);
                if (features.length > maxFeatures) throw areaLimitError('O2Map parcel limit exceeded; use a smaller area.');
            }
            // No total/count contract is supplied. A terminal short page ends this bounded enumeration;
            // it does not establish municipal completeness or an unobserved provider transfer ceiling.
            // O2Map's spatial filter can return envelopes just outside the requested WGS84 box
            // (retained live probe: north edge 36.342, parcel south edge 36.34200142).
            // Resolve intersection after complete paging, retaining full intersecting source polygons.
            if (rows.length < pageSize) return result(features.filter(feature => booleanIntersects(feature, footprint)));
        }
        throw areaLimitError('O2Map WFS exceeded the page limit; use a smaller area.');
    }

    async function queryGeometry(geometry, options = {}) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide a WGS84 Polygon or MultiPolygon.');
        const footprint = geoFeature(geometry);
        const read = await queryBounds(geometryBbox(footprint), options);
        return { ...read, features: read.features.filter(feature => booleanIntersects(feature, footprint)) };
    }
    return Object.freeze({ queryBounds, queryIds, queryGeometry });
}
