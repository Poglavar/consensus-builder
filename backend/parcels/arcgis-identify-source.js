// Read MapServer parcel layers that expose geometry through identify but disable query.
// Exact reads use a native GUID layer definition; no cached geometry or spatial ID guessing.
import { bbox, booleanIntersects, feature as turfFeature } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { concatBytes } from './byte-utils.js';
import { parseEsriParcelCollection } from './esri-parcel-reader.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';

const GUID = /^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$/;
const SAFE_FIELDS = new Set(['globalid', 'objectid', 'fid_1', 'parselno', 'adano', 'ilceadi', 'mahalleadi']);
const MAX_BYTES = 2 * 1024 * 1024;

export function arcgisIdentifyEndpoint(descriptor) {
    if (descriptor.adapter !== 'arcgis' || descriptor.queryMode !== 'identify') return null;
    const match = /^(https:\/\/[^?#]+\/MapServer)\/(\d+)$/.exec(descriptor.endpoint || '');
    return match ? `${match[1]}/identify` : null;
}

export function createArcgisIdentifySource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    const endpoint = arcgisIdentifyEndpoint(descriptor);
    const layerId = Number(descriptor.endpoint?.split('/').at(-1));
    const { idField, idPrefix, outFields } = descriptor;
    const extent = descriptor.identifyExtent;
    const limit = descriptor.identifyRecordLimit;
    if (!endpoint || idField !== 'globalid' || !idPrefix || !Array.isArray(outFields)
        || !outFields.includes(idField) || outFields.some(field => !SAFE_FIELDS.has(field))
        || !outFields.includes(descriptor.parcelNumberField)
        || !Number.isSafeInteger(limit) || limit < 2 || limit > 2000
        || !Array.isArray(extent) || extent.length !== 4 || !extent.every(Number.isFinite)
        || extent[0] >= extent[2] || extent[1] >= extent[3]
        || extent[0] < -180 || extent[2] > 180 || extent[1] < -90 || extent[3] > 90) {
        throw new Error('Invalid ArcGIS identify parcel descriptor.');
    }

    async function request(bounds, nativeId, signal) {
        const url = new URL(endpoint);
        const params = { f: 'json', geometry: bounds.join(','), geometryType: 'esriGeometryEnvelope',
            sr: '4326', layers: `all:${layerId}`, tolerance: '0', mapExtent: bounds.join(','),
            imageDisplay: '800,600,96', returnGeometry: 'true', returnFieldName: 'true',
            returnUnformattedValues: 'true', outFields: outFields.join(',') };
        if (nativeId) params.layerDefs = JSON.stringify({ [layerId]: `${idField} = '${nativeId}'` });
        url.search = new URLSearchParams(params).toString();
        const timeout = AbortSignal.timeout(descriptor.timeoutMs ?? 20000);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const response = await fetchImpl(url.href, { method: 'GET', redirect: 'error', signal: combined,
            headers: { Accept: 'application/json' } });
        if (!response.ok) throw providerHttpError(response);
        const reader = response.body?.getReader();
        if (!reader) throw upstreamError('ArcGIS identify response has no body.');
        const chunks = [];
        let size = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > MAX_BYTES) {
                    await reader.cancel();
                    throw upstreamError('ArcGIS identify response exceeds the byte limit.');
                }
                chunks.push(value);
            }
        } finally { reader.releaseLock(); }
        let payload;
        try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(concatBytes(chunks, size))); }
        catch { throw upstreamError('ArcGIS identify returned invalid JSON.'); }
        if (payload?.error) throw providerHttpError(payload.error.code);
        if (!Array.isArray(payload?.results)) throw upstreamError('ArcGIS identify omitted results.');
        // Identify has no offset paging. A saturated answer must never mark a cell complete.
        if (payload.exceededTransferLimit || payload.results.length >= limit) {
            throw upstreamError('ArcGIS identify result limit reached; request smaller cells.', 502, 'parcel-source-incomplete');
        }
        const seen = new Set();
        return payload.results.map(row => {
            const native = row?.attributes?.[idField];
            if (row.layerId !== layerId || row.geometryType !== 'esriGeometryPolygon'
                || !GUID.test(native || '') || nativeId && native !== nativeId || seen.has(native)) {
                throw upstreamError('ArcGIS identify returned a foreign, duplicate or mismatched parcel.');
            }
            seen.add(native);
            // identify ignores outFields on some servers. Discard everything except the fixed
            // cadastral key allowlist before constructing a canonical feature or retaining data.
            const attributes = Object.fromEntries(outFields.filter(key => key in row.attributes)
                .map(key => [key, row.attributes[key]]));
            const parsed = parseEsriParcelCollection({ geometryType: row.geometryType,
                spatialReference: row.geometry?.spatialReference,
                features: [{ attributes, geometry: row.geometry }] }).features[0];
            return canonicalParcelFeature(descriptor, parsed, native);
        });
    }

    const result = (features, extra = {}) => ({ type: 'FeatureCollection', features,
        sourceId: descriptor.id, returnsWGS84: true, complete: true, ...extra });

    async function queryBounds(bounds, { signal } = {}) {
        validateBounds(bounds, descriptor.maxBboxKm2 ?? 0.1);
        return result(await request(bounds, null, signal), { queryType: 'bounds', bbox: bounds });
    }

    async function queryIds(ids, { signal } = {}) {
        if (!Array.isArray(ids) || ids.length > 80 || ids.some(id => typeof id !== 'string'
            || !id.startsWith(idPrefix) || !GUID.test(id.slice(idPrefix.length)))) {
            throw new HttpError(400, 'Expected canonical native GUID parcel IDs.');
        }
        const features = [], absentIds = [];
        const deadline = AbortSignal.timeout(60000);
        const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
        for (const id of new Set(ids)) {
            const rows = await request(extent, id.slice(idPrefix.length), combined);
            if (rows.length > 1) throw upstreamError('ArcGIS identify native ID is not unique.');
            if (rows.length) features.push(rows[0]);
            else absentIds.push(id);
        }
        return result(features, { queryType: 'ids', absentIds });
    }

    async function queryGeometry(geometry, options) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Expected a WGS84 polygon.');
        const read = await queryBounds(bbox(geometry), options);
        return { ...read, features: read.features.filter(parcel => booleanIntersects(parcel, turfFeature(geometry))) };
    }
    return Object.freeze({ queryBounds, queryIds, queryGeometry });
}
