// haleconnect's INSPIRE GeoJSON omits match counts and does not support paging.
// Only a short bounded response proves enumeration; never infer it from a full page.
import { bbox, bboxPolygon, booleanIntersects, feature } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';
import { geoJsonResponseCrsMatches } from './response-crs.js';
import { concatBytes } from './byte-utils.js';

export function createHaleconnectInspireSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    const { id, endpoint, idPrefix } = descriptor;
    const limit = descriptor.pageSize ?? 1000;
    const byteLimit = descriptor.maxResponseBytes ?? 1048576;
    if (id !== 'mt-pa-lra-registered-land-parcels-wfs'
        || endpoint !== 'https://haleconnect.com/ows/services/org.1261.9e965259-f5a1-4e3e-8a64-41281f4d7ffe_wfs'
        || descriptor.featureType !== 'cp:CadastralParcel' || !idPrefix
        || descriptor.outFields?.length !== 0 || descriptor.responseSrid !== 4326
        || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000
        || !Number.isSafeInteger(byteLimit) || byteLimit < 1 || byteLimit > 16 * 1024 * 1024) {
        throw new Error('Invalid haleconnect INSPIRE source descriptor.');
    }
    const nativePattern = /^CP_[0-9]+_[0-9]+$/;
    async function query(params, count) {
        const url = new URL(endpoint);
        url.search = new URLSearchParams({ service: 'WFS', version: '2.0.0', request: 'GetFeature',
            typeNames: 'cp:CadastralParcel', outputFormat: 'application/geo+json', srsName: 'EPSG:4326',
            propertyName: 'geometry', count: String(count), ...params }).toString();
        const response = await fetchImpl(url.href, { signal: AbortSignal.timeout(30000), redirect: 'error',
            cache: 'no-store', headers: { Accept: 'application/geo+json' } });
        if (!response.ok) throw providerHttpError(response);
        const reader = response.body?.getReader();
        if (!reader) throw upstreamError('Parcel provider omitted its response body.');
        let payload, bytes = 0;
        const chunks = [];
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                bytes += value.byteLength;
                if (bytes > byteLimit) throw upstreamError('Parcel provider exceeded the response byte limit.');
                chunks.push(value);
            }
            payload = JSON.parse(new TextDecoder().decode(concatBytes(chunks)));
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        if (payload?.type !== 'FeatureCollection' || !Array.isArray(payload.features)
            || !geoJsonResponseCrsMatches(payload.crs, 4326)) throw upstreamError('Invalid parcel response or response CRS.');
        if (payload.features.length >= count) throw upstreamError('Parcel query may be truncated; request a smaller area.');
        const seen = new Set();
        const features = payload.features.map(row => {
            if (!nativePattern.test(row.id) || seen.has(row.id) || !validateGeometry(row.geometry)) {
                throw upstreamError('Invalid or duplicate parcel identity or polygon.');
            }
            const localId = row.properties?.inspireId?.Identifier?.localId;
            if (localId !== undefined && localId !== row.id) throw upstreamError('Conflicting native parcel identity.');
            seen.add(row.id);
            // PROPERTYNAME is ignored by this publisher. Discard all returned attributes.
            return canonicalParcelFeature(descriptor, { geometry: row.geometry, properties: {} }, row.id);
        });
        return { type: 'FeatureCollection', features, sourceId: id, complete: true, returnsWGS84: true };
    }
    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80) throw new HttpError(400, 'Provide between 1 and 80 parcel IDs.');
        const unique = [...new Set(ids)];
        // Validate the entire batch before making any request.
        const native = unique.map(value => {
            if (typeof value !== 'string' || !value.startsWith(idPrefix) || !nativePattern.test(value.slice(idPrefix.length))) {
                throw new HttpError(400, 'Invalid parcel ID for this source.');
            }
            return value.slice(idPrefix.length);
        });
        const features = [];
        for (const key of native) {
            const result = await query({ resourceId: key }, 2);
            if (result.features.some(row => row.properties.sourceParcelId !== key)) throw upstreamError('Exact parcel read returned a different identity.');
            features.push(...result.features);
        }
        const present = new Set(features.map(row => row.id));
        return { type: 'FeatureCollection', features, sourceId: id, complete: true, returnsWGS84: true,
            absentIds: unique.filter(key => !present.has(key)) };
    }
    async function queryBounds(bounds) {
        validateBounds(bounds, descriptor.maxBboxKm2 ?? 1, descriptor);
        const result = await query({ bbox: `${bounds.join(',')},EPSG:4326` }, limit);
        const footprint = bboxPolygon(bounds);
        return { ...result, features: result.features.filter(row => booleanIntersects(row, footprint)) };
    }
    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide a valid WGS84 polygon.');
        const shape = feature(geometry), result = await queryBounds(bbox(shape));
        return { ...result, features: result.features.filter(row => booleanIntersects(row, shape)) };
    }
    return Object.freeze({ queryIds, queryBounds, queryGeometry });
}
