// Tijuana's WMS has non-unique cve_cat values: preserve each unchanged public KML polygon
// with a native-key-plus-geometry reference, never a generated GeoServer feature ID.
import { bbox, bboxPolygon, booleanIntersects, booleanPointInPolygon, feature, point } from '@turf/turf';
import { parseParcelKml } from './kml-kmz-source.js';
import { concatBytes } from './byte-utils.js';
import { sha256Hex } from './portable-hash.js';
import { geoJsonResponseCrsMatches } from './response-crs.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';

const SOURCE = 'mx-tijuana-implan-catastro-wms';
const ENDPOINT = 'https://gemelodigital.implantijuana.gob.mx/geoserver-local-proxy/wms';
const LAYER = 'catastro_pub:predios-211126_Predios', PREFIX = 'MX-TIJUANA-CVE-';
const EXTENT = [-117.12429823771853, 32.2512730102276, -116.60335857175843, 32.56585025841466];
const MAX_BYTES = 8 * 1024 * 1024, LIMIT = 500, KEY_LIMIT = 64;
const nativeId = value => typeof value === 'string' && /^[A-Z]{2}[0-9]{6}$/.test(value);
const invalid = () => upstreamError('IMPLAN returned invalid, conflicting or truncated cadastral data.');
const inputError = () => upstreamError('Invalid Tijuana parcel query.', 400);
const hashGeometry = geometry => sha256Hex(JSON.stringify({ type: geometry.type, coordinates: geometry.coordinates }));
const boundsLimits = { maxBboxWidthM: 1000, maxBboxHeightM: 1000 };

function parseReference(id) {
    if (typeof id !== 'string' || !id.startsWith(PREFIX)) throw inputError();
    const match = /^([A-Z]{2}[0-9]{6}):([a-f0-9]{64})$/.exec(id.slice(PREFIX.length));
    if (!match) throw inputError();
    return { code: match[1], hash: match[2] };
}
function checkIds(ids) {
    if (!Array.isArray(ids) || ids.length > 80) throw inputError();
    ids.forEach(parseReference);
}
function canonical(descriptor, geometry, code) {
    const hash = hashGeometry(geometry);
    const row = canonicalParcelFeature(descriptor, { geometry, properties: { cve_cat: code } }, `${code}:${hash}`);
    Object.assign(row.properties, { sourceParcelId: code, parcelIdentityKind: 'attribute-geometry-sha256-v1', sourceGeometryHash: hash });
    return row;
}
async function readBody(response, maxBytes) {
    if (!response.ok) { await response.body?.cancel(); throw providerHttpError(response); }
    if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw invalid(); }
    const reader = response.body?.getReader(); if (!reader) throw invalid();
    const chunks = []; let size = 0;
    try {
        for (;;) {
            const { value, done } = await reader.read(); if (done) break;
            size += value.byteLength;
            if (size > maxBytes) throw invalid();
            chunks.push(value);
        }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    return concatBytes(chunks, size);
}

export function createTijuanaImplanSource(descriptor, { fetchImpl = globalThis.fetch, timeoutMs = 30000,
    maxResponseBytes = MAX_BYTES } = {}) {
    if (descriptor?.id !== SOURCE || descriptor.adapter !== 'tijuana-implan-wms' || descriptor.endpoint !== ENDPOINT
        || descriptor.layer !== LAYER || descriptor.idPrefix !== PREFIX || descriptor.idField !== 'cve_cat'
        || descriptor.idFields?.length !== 1 || descriptor.idFields[0] !== 'cve_cat'
        || descriptor.outFields?.length !== 1 || descriptor.outFields[0] !== 'cve_cat'
        || descriptor.identityKind !== 'attribute-geometry-sha256-v1'
        || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > MAX_BYTES
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 45000) throw new Error('Invalid Tijuana IMPLAN descriptor.');
    const result = (features, queryType, extra = {}) => ({ type: 'FeatureCollection', sourceId: SOURCE,
        returnsWGS84: true, complete: true, features, queryType, ...extra });

    async function request(parameters, signal) {
        const url = new URL(ENDPOINT);
        url.search = new URLSearchParams({ SERVICE: 'WMS', VERSION: '1.1.1', LAYERS: LAYER,
            STYLES: '', SRS: 'EPSG:4326', PROPERTYNAME: 'cve_cat,geom', ...parameters }).toString();
        const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
        try {
            const response = await fetchImpl(url.href, { method: 'GET', credentials: 'omit', redirect: 'error',
                signal: combined, headers: { Accept: parameters.REQUEST === 'GetMap' ? 'application/vnd.google-earth.kml+xml' : 'application/json' } });
            return await readBody(response, maxResponseBytes);
        } catch (error) {
            if (signal?.aborted) throw signal.reason;
            if (combined.aborted) throw upstreamError('IMPLAN parcel provider timed out.', 504);
            if (error.status) throw error;
            throw upstreamError('IMPLAN parcel provider is unavailable.');
        }
    }

    async function manifest(bounds, signal) {
        // Large-image GFI samples the click neighbourhood even with BUFFER set.
        // An 8-pixel ID-only frame includes known edge parcels; spatial CQL scopes it.
        const bytes = await request({ REQUEST: 'GetFeatureInfo', QUERY_LAYERS: LAYER, BBOX: bounds.join(','),
            WIDTH: '8', HEIGHT: '8', X: '4', Y: '4', BUFFER: '8', FORMAT: 'image/png',
            INFO_FORMAT: 'application/json', FEATURE_COUNT: String(LIMIT + 1), PROPERTYNAME: 'cve_cat',
            CQL_FILTER: `BBOX(geom,${bounds.join(',')},'EPSG:4326')` }, signal);
        let payload;
        try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw invalid(); }
        if (payload?.type !== 'FeatureCollection' || !Array.isArray(payload.features)
            || payload.features.length > LIMIT || payload.error || payload.exceededTransferLimit
            || !geoJsonResponseCrsMatches(payload.crs, 4326)
            || (payload.numberReturned !== undefined && payload.numberReturned !== payload.features.length)) throw invalid();
        const keys = new Set();
        for (const row of payload.features) {
            const code = row?.properties?.cve_cat;
            if (!nativeId(code) || Object.keys(row.properties).some(key => key !== 'cve_cat')) throw invalid();
            // A key can name distinct records. Fetch that entire bounded native-key group once.
            keys.add(code);
        }
        return [...keys];
    }

    async function readNativeKey(code, signal) {
        // GeoServer's attribute-free KML preserves whole source polygon rings. CQL
        // supplies the native key; transport FIDs, names and response order are ignored.
        const bytes = await request({ REQUEST: 'GetMap', BBOX: EXTENT.join(','), WIDTH: '512', HEIGHT: '512',
            FORMAT: 'application/vnd.google-earth.kml+xml', maxFeatures: String(KEY_LIMIT + 1),
            format_options: 'KMSCORE:100;KMPLACEMARK:false;KMATTR:false', CQL_FILTER: `cve_cat = '${code}'` }, signal);
        const rows = parseParcelKml(bytes, { ...descriptor, maxDecompressedBytes: maxResponseBytes,
            maxSnapshotFeatures: KEY_LIMIT + 1, kmlAllowEmpty: true, kmlAllowLabelPoints: true }, { geometryOnly: true }).features;
        if (rows.length > KEY_LIMIT) throw invalid();
        const byReference = new Map();
        for (const row of rows) {
            const clean = canonical(descriptor, row.geometry, code);
            // Byte-identical native-key/geometry representations are the same reference;
            // different source polygons remain separate, including genuine overlaps.
            if (!byReference.has(clean.id)) byReference.set(clean.id, clean);
        }
        return [...byReference.values()];
    }

    async function readKeys(keys, signal) {
        const features = [];
        for (let at = 0; at < keys.length; at += 2) {
            features.push(...(await Promise.all(keys.slice(at, at + 2).map(code => readNativeKey(code, signal)))).flat());
            if (features.length > LIMIT) throw invalid();
        }
        return features;
    }
    async function queryIds(ids, { signal } = {}) {
        checkIds(ids);
        const unique = [...new Set(ids)], keys = [...new Set(unique.map(id => parseReference(id).code))];
        const features = (await readKeys(keys, signal)).filter(row => unique.includes(row.id));
        const found = new Set(features.map(row => row.id));
        return result(features, 'ids', { absentIds: unique.filter(id => !found.has(id)) });
    }
    async function queryBounds(bounds, { signal } = {}) {
        validateBounds(bounds, 1, boundsLimits);
        if (bounds[2] < EXTENT[0] || bounds[0] > EXTENT[2] || bounds[3] < EXTENT[1] || bounds[1] > EXTENT[3]) return result([], 'bounds');
        const keys = await manifest(bounds, signal), rows = await readKeys(keys, signal);
        const found = new Set(rows.map(row => row.properties.sourceParcelId));
        if (keys.some(code => !found.has(code))) throw invalid();
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

export function isTijuanaImplanSource(descriptor) {
    return descriptor?.id === SOURCE && descriptor.adapter === 'tijuana-implan-wms' && descriptor.endpoint === ENDPOINT;
}
export function parseTijuanaOperation(body) {
    let data;
    try { data = JSON.parse(body); } catch { throw inputError(); }
    if (!data || Object.keys(data).length !== 2 || !Object.hasOwn(data, 'input')
        || !['queryIds', 'queryBounds', 'queryGeometry', 'queryPoint'].includes(data._tijuanaOperation)) throw inputError();
    if (data._tijuanaOperation === 'queryIds') checkIds(data.input);
    if (data._tijuanaOperation === 'queryBounds') validateBounds(data.input, 1, boundsLimits);
    if (data._tijuanaOperation === 'queryGeometry') {
        if (!validateGeometry(data.input)) throw inputError();
        validateBounds(bbox(feature(data.input)), 1, boundsLimits);
    }
    if (data._tijuanaOperation === 'queryPoint' && (!Array.isArray(data.input) || data.input.length !== 2
        || !data.input.every(Number.isFinite) || Math.abs(data.input[0]) > 180 || Math.abs(data.input[1]) > 90)) throw inputError();
    return data;
}

// One bounded operation per browser relay call; every exact reference is fetched
// live and its unchanged geometry hash is checked again in the browser adapter.
export function createTijuanaImplanBrowserSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    createTijuanaImplanSource(descriptor, { fetchImpl });
    const operation = method => async (input, { signal } = {}) => {
        const body = JSON.stringify({ _tijuanaOperation: method, input });
        parseTijuanaOperation(body);
        const response = await fetchImpl(ENDPOINT, { method: 'POST', body, credentials: 'omit', redirect: 'error',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(65000)]) : AbortSignal.timeout(65000) });
        const bytes = await readBody(response, MAX_BYTES);
        let data;
        try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw invalid(); }
        if (data?.type !== 'FeatureCollection' || data.sourceId !== SOURCE || data.complete !== true
            || !Array.isArray(data.features) || data.features.length > LIMIT) throw invalid();
        const seen = new Set();
        const features = data.features.map(row => {
            const code = row?.properties?.sourceParcelId;
            if (!nativeId(code) || row.properties.sourceId !== SOURCE || seen.has(row.id) || !validateGeometry(row.geometry)) throw invalid();
            const clean = canonical(descriptor, row.geometry, code);
            if (row.id !== clean.id) throw invalid();
            seen.add(row.id);
            return clean;
        });
        if (method === 'queryIds' && (!Array.isArray(data.absentIds)
            || data.absentIds.some(id => !input.includes(id) || seen.has(id))
            || new Set([...seen, ...data.absentIds]).size !== new Set(input).size
            || features.some(row => !input.includes(row.id)))) throw invalid();
        return { type: 'FeatureCollection', sourceId: SOURCE, returnsWGS84: true, complete: true, features,
            queryType: data.queryType, ...(method === 'queryIds' ? { absentIds: data.absentIds } : {}) };
    };
    return Object.freeze(Object.fromEntries(['queryIds', 'queryBounds', 'queryGeometry', 'queryPoint'].map(method => [method, operation(method)])));
}
