// Read ASIG's live cadastral KML with bounded requests and native inspireid filters.
import { bbox, booleanIntersects, feature } from '@turf/turf';
import { parseParcelKml } from './kml-kmz-source.js';
import { concatBytes } from './byte-utils.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';

export const ASIG_SOURCE_ID = 'al-asig-zrpp-albscad-parcels-072026';
export const ASIG_ENDPOINT = 'https://geoportal.asig.gov.al/service/zrpp/ows';
const LAYER = 'p_kadas_albscad_072026', PREFIX = 'AL-ASIG-';
const EXTENT = [19.238927169468482, 39.64031238851075, 21.090454133262412, 42.661314178919916];
const MAX_BYTES = 8 * 1024 * 1024, LIMIT = 1000, BATCH = 80;
const nativeId = id => /^ASHK_PK__[0-9]{1,20}$/.test(id);
const invalid = () => upstreamError('ASIG returned invalid, conflicting or truncated parcel data.');
const inputError = () => upstreamError('Invalid ASIG parcel query.', 400);

export function createAsigWmsKmlParcelSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    if (descriptor.id !== ASIG_SOURCE_ID || descriptor.endpoint !== ASIG_ENDPOINT || descriptor.adapter !== 'asig-wms-kml'
        || descriptor.layer !== LAYER || descriptor.style !== 'polygon' || descriptor.idPrefix !== PREFIX
        || descriptor.idField !== 'inspireid' || descriptor.idFields?.length !== 1 || descriptor.idFields[0] !== 'inspireid'
        || descriptor.outFields?.length !== 1 || descriptor.outFields[0] !== 'inspireid'
        || descriptor.kmlIdEncoding !== 'geoserver-span-string' || descriptor.kmlAllowLabelPoints !== true
        || descriptor.maxFeatures !== LIMIT || descriptor.maxResponseBytes !== MAX_BYTES) throw new Error('Invalid ASIG WMS-KML descriptor.');
    const result = (features, queryType, extra = {}) => ({ type: 'FeatureCollection', sourceId: ASIG_SOURCE_ID,
        returnsWGS84: true, complete: true, features, queryType, ...extra });

    async function request(bounds, ids, signal) {
        const limit = ids ? ids.length + 1 : LIMIT + 1;
        const params = new URLSearchParams({ service: 'WMS', version: '1.3.0', request: 'GetMap',
            layers: LAYER, styles: 'polygon', crs: 'CRS:84', bbox: bounds.join(','), width: '800', height: '800',
            format: 'application/vnd.google-earth.kml+xml',
            format_options: 'KMSCORE:0;KMPLACEMARK:false;KMATTR:true', propertyName: 'inspireid', maxFeatures: String(limit),
            ...(ids ? { CQL_FILTER: `inspireid IN (${ids.map(id => `'${id}'`).join(',')})` } : {}) });
        const response = await fetchImpl(`${ASIG_ENDPOINT}?${params}`, { method: 'GET', credentials: 'omit', redirect: 'error',
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
            headers: { Accept: 'application/vnd.google-earth.kml+xml' } });
        if (!response.ok) { await response.body?.cancel(); throw providerHttpError(response); }
        if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body?.cancel(); throw invalid(); }
        const reader = response.body?.getReader(); if (!reader) throw invalid();
        const chunks = []; let size = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read(); if (done) break;
                size += value.byteLength;
                if (size > MAX_BYTES) throw invalid();
                chunks.push(value);
            }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const parsed = parseParcelKml(concatBytes(chunks, size), { ...descriptor,
            maxDecompressedBytes: MAX_BYTES, maxSnapshotFeatures: limit, kmlAllowEmpty: true });
        // The live service honors maxFeatures. A sentinel row means enumeration may be truncated.
        if (parsed.features.length >= limit) throw invalid();
        return parsed.features.map(row => {
            const id = row.properties.inspireid;
            if (!nativeId(id) || ids && !ids.includes(id)) throw invalid();
            return canonicalParcelFeature(descriptor, row, id);
        });
    }

    async function queryIds(ids, { signal } = {}) {
        if (!Array.isArray(ids) || ids.length > BATCH || ids.some(id => typeof id !== 'string'
            || !id.startsWith(PREFIX) || !nativeId(id.slice(PREFIX.length)))) throw inputError();
        const unique = [...new Set(ids)];
        if (!unique.length) return result([], 'ids', { absentIds: [] });
        // A scale-independent polygon style is essential: the published display style hides
        // parcels at a national map scale. CQL selects only the requested native records.
        const features = await request(EXTENT, unique.map(id => id.slice(PREFIX.length)), signal);
        const found = new Set(features.map(row => row.id));
        return result(features, 'ids', { absentIds: unique.filter(id => !found.has(id)) });
    }
    async function queryBounds(bounds, { signal } = {}) {
        validateBounds(bounds, descriptor.maxBboxKm2);
        if (bounds[2] < EXTENT[0] || bounds[0] > EXTENT[2] || bounds[3] < EXTENT[1] || bounds[1] > EXTENT[3]) return result([], 'bounds');
        const features = await request(bounds, null, signal);
        return result(features, 'bounds');
    }
    async function queryGeometry(geometry, options) {
        if (!validateGeometry(geometry)) throw inputError();
        const scope = feature(geometry), read = await queryBounds(bbox(scope), options);
        return result(read.features.filter(row => booleanIntersects(row, scope)), 'geometry');
    }
    return Object.freeze({ queryIds, queryBounds, queryGeometry });
}
