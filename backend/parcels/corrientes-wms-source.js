// Corrientes: safe gid manifests through bounded GFI, whole polygons through
// single-gid WMS KML filters with popup attributes explicitly disabled.
import { bbox, bboxPolygon, booleanIntersects, booleanPointInPolygon, feature, point } from '@turf/turf';
import { parseParcelKml } from './kml-kmz-source.js';
import { concatBytes } from './byte-utils.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';

export const CORRIENTES_SOURCE = 'AR-CORRIENTES-MUNI-IDEMCC-WMS-PARCELS';
export const CORRIENTES_ENDPOINT = 'https://gisdesa.ciudaddecorrientes.gov.ar:8282/geoserver/wms';
const LAYER = 'informacion_catastral:vw_parcelas', PREFIX = 'AR-CORRIENTES-MUNI-GID-';
// Routing window for this municipal service, not a statement of parcel coverage.
const EXTENT = [-59, -28, -58, -27], STEP = 0.001;
const MAX_BYTES = 8 * 1024 * 1024, LIMIT = 500;
const validId = value => /^[1-9][0-9]{0,9}$/.test(value);
const invalid = () => upstreamError('Corrientes returned invalid, conflicting or truncated parcel data.');
const inputError = () => upstreamError('Invalid Corrientes parcel query.', 400);

function checkIds(ids) {
    if (!Array.isArray(ids) || ids.length > 80 || ids.some(id => typeof id !== 'string'
        || !id.startsWith(PREFIX) || !validId(id.slice(PREFIX.length)))) throw inputError();
}

async function readBody(response, maxResponseBytes) {
    if (!response.ok) { await response.body?.cancel(); throw providerHttpError(response); }
    if (Number(response.headers.get('content-length')) > maxResponseBytes) { await response.body?.cancel(); throw invalid(); }
    const reader = response.body?.getReader(); if (!reader) throw invalid();
    let size = 0; const chunks = [];
    try {
        for (;;) {
            const { done, value } = await reader.read(); if (done) break;
            size += value.byteLength;
            if (size > maxResponseBytes) throw invalid();
            chunks.push(value);
        }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    return concatBytes(chunks, size);
}

export function createCorrientesWmsSource(descriptor, { fetchImpl = globalThis.fetch, timeoutMs = 30000,
    maxResponseBytes = MAX_BYTES } = {}) {
    if (descriptor?.id !== CORRIENTES_SOURCE || descriptor.adapter !== 'corrientes-wms' || descriptor.endpoint !== CORRIENTES_ENDPOINT
        || descriptor.layer !== LAYER || descriptor.idPrefix !== PREFIX || descriptor.idField !== 'gid'
        || descriptor.idFields?.length !== 1 || descriptor.idFields[0] !== 'gid'
        || descriptor.outFields?.length !== 1 || descriptor.outFields[0] !== 'gid'
        || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > MAX_BYTES
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 45000) throw new Error('Invalid Corrientes WMS descriptor.');
    const result = (features, queryType, extra = {}) => ({ type: 'FeatureCollection', sourceId: CORRIENTES_SOURCE,
        returnsWGS84: true, complete: true, features, queryType, ...extra });

    async function request(parameters, accept, signal) {
        const url = new URL(CORRIENTES_ENDPOINT);
        url.search = new URLSearchParams({ service: 'WMS', version: '1.3.0', layers: LAYER,
            styles: '', crs: 'CRS:84', ...parameters }).toString();
        const response = await fetchImpl(url.href, { method: 'GET', credentials: 'omit', redirect: 'error',
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
            headers: { Accept: accept } });
        return readBody(response, maxResponseBytes);
    }

    async function exact(nativeId, signal) {
        // GetMap propertyName does not suppress this publisher's popup template.
        // KMATTR:false does: request no popup data and reject it if it reappears.
        // Never use the changing GeoServer fid or response ordering as identity.
        const bytes = await request({ request: 'GetMap', bbox: EXTENT.join(','), width: '800', height: '800',
            format: 'application/vnd.google-earth.kml+xml', maxFeatures: '2',
            format_options: 'KMSCORE:100;KMPLACEMARK:false;KMATTR:false', propertyName: 'gid,the_geom',
            CQL_FILTER: `gid = ${nativeId}` }, 'application/vnd.google-earth.kml+xml', signal);
        const read = parseParcelKml(bytes, { ...descriptor, maxDecompressedBytes: maxResponseBytes,
            maxSnapshotFeatures: 2, kmlAllowEmpty: true, kmlAllowLabelPoints: true }, { geometryOnly: true });
        if (read.features.length >= 2) throw invalid(); // Duplicate gids or an ignored filter are unsafe.
        return read.features.map(row => canonicalParcelFeature(descriptor, { ...row, properties: { gid: nativeId } }, nativeId));
    }

    async function queryIds(ids, { signal } = {}) {
        checkIds(ids);
        const unique = [...new Set(ids)], features = [];
        // Bound provider concurrency, including callers passing the production batch of 80.
        for (let at = 0; at < unique.length; at += 2) {
            const reads = await Promise.all(unique.slice(at, at + 2).map(id => exact(id.slice(PREFIX.length), signal)));
            features.push(...reads.flat());
        }
        const found = new Set(features.map(row => row.id));
        return result(features, 'ids', { absentIds: unique.filter(id => !found.has(id)) });
    }

    async function queryBounds(bounds, { signal } = {}) {
        validateBounds(bounds, 0.25);
        if (bounds[2] < EXTENT[0] || bounds[0] > EXTENT[2] || bounds[3] < EXTENT[1] || bounds[1] > EXTENT[3]) return result([], 'bounds');
        const x0 = Math.floor(bounds[0] / STEP), x1 = Math.ceil(bounds[2] / STEP);
        const y0 = Math.floor(bounds[1] / STEP), y1 = Math.ceil(bounds[3] / STEP);
        if ((x1 - x0) * (y1 - y0) > 64) throw inputError();
        const ids = new Set();
        for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) {
            const cell = [x * STEP, y * STEP, (x + 1) * STEP, (y + 1) * STEP].map(v => Number(v.toFixed(8)));
            // Small fixed frames avoid the provider's scale-dependent empty GFI results.
            // The radius exceeds the frame diagonal. CQL supplies exact bbox membership.
            const bytes = await request({ request: 'GetFeatureInfo', query_layers: LAYER, bbox: cell.join(','),
                width: '16', height: '16', i: '8', j: '8', buffer: '16', info_format: 'application/json',
                feature_count: String(LIMIT + 1), propertyName: 'gid',
                CQL_FILTER: `BBOX(the_geom,${bounds.join(',')},'EPSG:4326')` }, 'application/json', signal);
            let payload;
            try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw invalid(); }
            if (payload?.type !== 'FeatureCollection' || !Array.isArray(payload.features)
                || payload.features.length >= LIMIT + 1 || payload.error || payload.exceededTransferLimit) throw invalid();
            const seen = new Set();
            for (const row of payload.features) {
                const gid = row?.properties?.gid;
                if (!Number.isSafeInteger(gid) || !validId(String(gid)) || seen.has(gid)
                    || Object.keys(row.properties).some(key => key !== 'gid')) throw invalid();
                seen.add(gid); ids.add(`${PREFIX}${gid}`);
            }
            if (ids.size > LIMIT) throw invalid();
        }
        const rows = [];
        for (let at = 0, list = [...ids]; at < list.length; at += 80) {
            const read = await queryIds(list.slice(at, at + 80), { signal });
            if (read.absentIds.length) throw invalid();
            rows.push(...read.features);
        }
        const scope = bboxPolygon(bounds);
        return result(rows.filter(row => booleanIntersects(row, scope)), 'bounds');
    }
    async function queryGeometry(geometry, options) {
        if (!validateGeometry(geometry)) throw inputError();
        const read = await queryBounds(bbox(feature(geometry)), options);
        return result(read.features.filter(row => booleanIntersects(row, feature(geometry))), 'geometry');
    }
    async function queryPoint(position, options) {
        if (!Array.isArray(position) || position.length !== 2 || !position.every(Number.isFinite)
            || Math.abs(position[0]) > 180 || Math.abs(position[1]) > 90) throw inputError();
        const [x, y] = position;
        const read = await queryBounds([x - 0.000001, y - 0.000001, x + 0.000001, y + 0.000001], options);
        return result(read.features.filter(row => booleanPointInPolygon(point(position), row)), 'point');
    }
    return Object.freeze({ queryIds, queryBounds, queryGeometry, queryPoint });
}

export function isCorrientesSource(descriptor) {
    return descriptor?.id === CORRIENTES_SOURCE && descriptor.adapter === 'corrientes-wms'
        && descriptor.endpoint === CORRIENTES_ENDPOINT;
}

export function parseCorrientesOperation(body) {
    let data;
    try { data = JSON.parse(body); } catch { throw inputError(); }
    if (!data || Object.keys(data).length !== 2 || !Object.hasOwn(data, 'input')
        || !['queryIds', 'queryBounds', 'queryGeometry', 'queryPoint'].includes(data._corrientesOperation)) throw inputError();
    if (data._corrientesOperation === 'queryIds') checkIds(data.input);
    if (data._corrientesOperation === 'queryBounds') validateBounds(data.input, 0.25);
    if (data._corrientesOperation === 'queryGeometry' && !validateGeometry(data.input)) throw inputError();
    if (data._corrientesOperation === 'queryPoint' && (!Array.isArray(data.input) || data.input.length !== 2
        || !data.input.every(Number.isFinite) || Math.abs(data.input[0]) > 180 || Math.abs(data.input[1]) > 90)) throw inputError();
    return data;
}

// One bounded source operation per browser relay request. The server performs the
// same fresh native reads; no source data is substituted by a sample or a cache.
export function createCorrientesBrowserSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    createCorrientesWmsSource(descriptor, { fetchImpl }); // Validate the exact production profile.
    const operation = method => async (input, { signal } = {}) => {
        const body = JSON.stringify({ _corrientesOperation: method, input });
        parseCorrientesOperation(body);
        const response = await fetchImpl(CORRIENTES_ENDPOINT, { method: 'POST', body, credentials: 'omit', redirect: 'error',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(65000)]) : AbortSignal.timeout(65000) });
        const bytes = await readBody(response, MAX_BYTES);
        let data;
        try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw invalid(); }
        if (data?.type !== 'FeatureCollection' || data.sourceId !== CORRIENTES_SOURCE || data.complete !== true
            || !Array.isArray(data.features) || data.features.length > LIMIT) throw invalid();
        const seen = new Set();
        const features = data.features.map(row => {
            const nativeId = row?.properties?.sourceParcelId;
            if (typeof nativeId !== 'string' || !validId(nativeId) || row.id !== `${PREFIX}${nativeId}`
                || row.properties.sourceId !== CORRIENTES_SOURCE || seen.has(row.id) || !validateGeometry(row.geometry)) throw invalid();
            seen.add(row.id);
            return canonicalParcelFeature(descriptor, { geometry: row.geometry, properties: { gid: nativeId } }, nativeId);
        });
        if (method === 'queryIds') {
            if (!Array.isArray(data.absentIds) || data.absentIds.some(id => !input.includes(id) || seen.has(id))
                || new Set([...seen, ...data.absentIds]).size !== new Set(input).size
                || features.some(row => !input.includes(row.id))) throw invalid();
        }
        return { type: 'FeatureCollection', sourceId: CORRIENTES_SOURCE, returnsWGS84: true, complete: true,
            features, queryType: data.queryType, ...(method === 'queryIds' ? { absentIds: data.absentIds } : {}) };
    };
    return Object.freeze(Object.fromEntries(['queryIds', 'queryBounds', 'queryGeometry', 'queryPoint'].map(method => [method, operation(method)])));
}
