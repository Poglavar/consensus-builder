// Read Rome's cadastral land polygons through QGIS WMS filters, without pixel sampling,
// caching exact reads, or altering provider geometry. Building/road records are excluded.
import { bbox, booleanIntersects, booleanPointInPolygon, feature as turfFeature, point as turfPoint } from '@turf/turf';
import { concatBytes } from './byte-utils.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';

const SOURCE = 'it-roma-metropolitana-sit-cadastral-parcels';
const ENDPOINT = 'https://g3w-suite.cittametropolitanaroma.it/ows/19/qdjango/224/';
const LAYER = 'Catasto_Totale_0f4af963_a62b_449a_9d28_6f37d9826dc8';
const PREFIX = 'IT-ROMA-SIT-';
const BASE_FILTER = '"codice_comune" = \'H501\' AND "tipo" = \'T\'';
const MAX_BYTES = 8 * 1024 * 1024;
const invalid = () => upstreamError('Rome cadastral provider returned an invalid or truncated parcel response.');
const inputError = message => Object.assign(new Error(message), { status: 400, code: 'invalid-parcel-query' });
const validNativeId = id => typeof id === 'string' && id.startsWith(`${LAYER}.`)
    && /^[1-9][0-9]{0,9}$/.test(id.slice(LAYER.length + 1));

export function createRomaQgisWmsSource(descriptor, { fetchImpl = globalThis.fetch, timeoutMs = 30000,
    maxResponseBytes = MAX_BYTES } = {}) {
    if (descriptor?.id !== SOURCE || descriptor.adapter !== 'roma-qgis-wms' || descriptor.endpoint !== ENDPOINT
        || descriptor.layer !== LAYER || descriptor.idPrefix !== PREFIX || descriptor.idField !== 'id'
        || descriptor.outFields?.length !== 1 || descriptor.outFields[0] !== 'id'
        || typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 45000
        || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > MAX_BYTES) {
        throw new Error('Invalid Rome QGIS WMS cadastral descriptor.');
    }
    const result = (features, queryType, extra = {}) => ({ type: 'FeatureCollection', features, complete: true,
        sourceId: SOURCE, returnsWGS84: true, queryType, ...extra });

    async function request(parameters, limit, signal) {
        const url = new URL(ENDPOINT);
        // Do not supply BBOX/X/Y: QGIS otherwise intersects the attribute filter with
        // a single map pixel, silently omitting parcels away from that pixel.
        url.search = new URLSearchParams({ SERVICE: 'WMS', VERSION: '1.1.1', REQUEST: 'GetFeatureInfo',
            LAYERS: LAYER, QUERY_LAYERS: LAYER, SRS: 'EPSG:4326', INFO_FORMAT: 'application/json',
            WITH_GEOMETRY: 'true', WITH_MAPTIP: 'false', WITH_DISPLAY_NAME: 'false',
            FEATURE_COUNT: String(limit), FILTER: `${LAYER}:${BASE_FILTER}`, ...parameters }).toString();
        const timeout = AbortSignal.timeout(timeoutMs);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        try {
            const response = await fetchImpl(url.href, { method: 'GET', redirect: 'error', credentials: 'omit',
                headers: { Accept: 'application/json' }, signal: combined });
            if (!response.ok) throw providerHttpError(response);
            const declared = response.headers.get('content-length');
            if (declared && Number(declared) > maxResponseBytes) { await response.body?.cancel(); throw invalid(); }
            const reader = response.body?.getReader();
            if (!reader) throw invalid();
            let size = 0;
            const chunks = [];
            try {
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    size += value.byteLength;
                    if (size > maxResponseBytes) { await reader.cancel(); throw invalid(); }
                    chunks.push(value);
                }
            } finally { reader.releaseLock(); }
            let payload;
            try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(concatBytes(chunks, size))); }
            catch { throw invalid(); }
            if (payload?.type !== 'FeatureCollection' || !Array.isArray(payload.features)
                || payload.features.length >= limit || payload.error || payload.exceededTransferLimit) throw invalid();
            const seen = new Set();
            return payload.features.map(row => {
                if (!validNativeId(row?.id) || !validateGeometry(row.geometry) || seen.has(row.id)
                    || row.properties?.['Codice Comune'] !== 'H501' || row.properties?.Tipo !== 'T') throw invalid();
                seen.add(row.id);
                // The fixed provider response includes cadastral sheet/type fields only.
                // Persist nothing except its complete native layer-qualified ID and geometry.
                return canonicalParcelFeature(descriptor, { type: 'Feature', geometry: row.geometry,
                    properties: { id: row.id } }, row.id);
            });
        } catch (error) {
            if (signal?.aborted) throw signal.reason;
            if (combined.aborted) throw upstreamError('Rome cadastral provider timed out.', 504);
            if (error.status) throw error;
            throw upstreamError('Rome cadastral provider is unavailable.');
        }
    }

    async function queryIds(ids, { signal } = {}) {
        if (!Array.isArray(ids) || ids.length > 80 || ids.some(id => typeof id !== 'string'
            || !id.startsWith(PREFIX) || !validNativeId(id.slice(PREFIX.length)))) {
            throw inputError('Expected at most 80 canonical Rome cadastral IDs.');
        }
        const unique = [...new Set(ids)];
        if (!unique.length) return result([], 'ids', { absentIds: [] });
        const gids = unique.map(id => id.slice(PREFIX.length + LAYER.length + 1));
        const features = await request({ FILTER: `${LAYER}:${BASE_FILTER} AND "gid" IN ( ${gids.join(' , ')} )` }, unique.length + 1, signal);
        const requested = new Set(unique);
        if (features.some(row => !requested.has(row.id))) throw invalid();
        const found = new Set(features.map(row => row.id));
        return result(features, 'ids', { absentIds: unique.filter(id => !found.has(id)) });
    }

    async function queryBounds(bounds, { signal } = {}) {
        const [w, s, e, n] = validateBounds(bounds, 1);
        const wkt = `POLYGON((${w} ${s},${e} ${s},${e} ${n},${w} ${n},${w} ${s}))`;
        const features = await request({ FILTER_GEOM: wkt }, 1001, signal);
        const polygon = turfFeature({ type: 'Polygon', coordinates: [[[w,s],[e,s],[e,n],[w,n],[w,s]]] });
        if (features.some(row => !booleanIntersects(turfFeature(row.geometry), polygon))) throw invalid();
        return result(features, 'bounds');
    }

    async function queryPoint(point, options) {
        if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)
            || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) throw inputError('Expected WGS84 [longitude, latitude].');
        const [x,y] = point;
        const read = await queryBounds([x - 0.000001,y - 0.000001,x + 0.000001,y + 0.000001], options);
        return result(read.features.filter(row => booleanPointInPolygon(turfPoint(point), turfFeature(row.geometry))), 'point');
    }

    async function queryGeometry(geometry, options) {
        if (!validateGeometry(geometry)) throw inputError('Expected a WGS84 Polygon or MultiPolygon.');
        const read = await queryBounds(bbox(turfFeature(geometry)), options);
        return result(read.features.filter(row => booleanIntersects(turfFeature(row.geometry), turfFeature(geometry))), 'geometry');
    }
    return Object.freeze({ queryIds, queryBounds, queryPoint, queryGeometry });
}
