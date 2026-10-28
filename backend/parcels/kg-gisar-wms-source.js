// GISAR cadastral polygons: native ENI filters and scale-aware bounded WMS reads.
// Never use transport oid, clicked pixels, cached geometry, or incidental attributes as identity.
import proj4 from 'proj4';
import { bbox, bboxPolygon, booleanIntersects, booleanPointInPolygon, feature, point } from '@turf/turf';
import { concatBytes } from './byte-utils.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';
import { geoJsonResponseCrsMatches } from './response-crs.js';

export const GISAR_ENDPOINT = 'http://map.darek.kg/qgis/qgis_mapserv.fcgi.exe?MAP=C%3A%2FOSGeo4W64%2Fprojects%2F%D0%93%D0%98%D0%A1%D0%90%D0%A0%2F%D0%93%D0%98%D0%A1%D0%90%D0%A0.qgz';
export const GISAR_SOURCE_ID = 'kg-bishkek-gisar-eni';
const LAYER = 'Участки ЕНИ', PREFIX = 'KG-GISAR-ENI-CODE-';
const CODE = /^[0-9]-[0-9]{2}-[0-9]{2}-[0-9]{4}-[0-9]{4}$/;
const LAND_FILTER = `${LAYER}:"propcode" LIKE '_-__-__-____-____'`;
const BASE = Object.freeze({ SERVICE: 'WMS', VERSION: '1.3.0', REQUEST: 'GetFeatureInfo',
    LAYERS: LAYER, QUERY_LAYERS: LAYER, CRS: 'EPSG:3857', INFO_FORMAT: 'application/geo+json',
    WITH_GEOMETRY: 'true', WITH_MAPTIP: 'false', WITH_DISPLAY_NAME: 'false' });
const MAX_BYTES = 8 * 1024 * 1024, MAX_COUNT = 501;
const invalid = (reason = 'invalid, conflicting or truncated cadastral polygons') => upstreamError(`GISAR returned ${reason}.`);
const inputError = message => Object.assign(new Error(message), { status: 400, code: 'invalid-parcel-query' });

// HTTP is permitted only for this fixed, public, read-only service and these bounded queries.
// Reuse this predicate at both relay admission and the DNS-pinned transport boundary.
export function isGisarParcelUrl(url) {
    if (!(url instanceof URL)) return false;
    const endpoint = new URL(GISAR_ENDPOINT), p = url.searchParams;
    if (url.origin !== endpoint.origin || url.pathname !== endpoint.pathname || url.username || url.password || url.hash
        || p.get('MAP') !== endpoint.searchParams.get('MAP')) return false;
    const allowed = new Set(['MAP', ...Object.keys(BASE), 'FEATURE_COUNT', 'FILTER', 'BBOX', 'WIDTH', 'HEIGHT']);
    if ([...p.keys()].some(key => !allowed.has(key) || p.getAll(key).length !== 1)
        || Object.entries(BASE).some(([key, value]) => p.get(key) !== value)) return false;
    const count = Number(p.get('FEATURE_COUNT'));
    if (!Number.isSafeInteger(count) || count < 2 || count > MAX_COUNT) return false;
    if (p.get('FILTER') === LAND_FILTER) {
        const b = (p.get('BBOX') || '').split(',').map(Number);
        return b.length === 4 && b.every(x => Number.isFinite(x) && Math.abs(x) <= 20037508.34278925)
            && b[0] < b[2] && b[1] < b[3] && b[2] - b[0] <= 3000 && b[3] - b[1] <= 3000
            && ['WIDTH', 'HEIGHT'].every(key => Number.isSafeInteger(Number(p.get(key))) && Number(p.get(key)) >= 128 && Number(p.get(key)) <= 4096);
    }
    if (['BBOX', 'WIDTH', 'HEIGHT'].some(key => p.has(key))) return false;
    const filter = p.get('FILTER') || '', prefix = `${LAYER}:"propcode" IN ( `;
    if (!filter.startsWith(prefix) || !filter.endsWith(' )')) return false;
    const values = filter.slice(prefix.length, -2).split(' , ');
    return values.length > 0 && values.length <= 80 && count === values.length + 1
        && values.every(value => value.startsWith("'") && value.endsWith("'") && CODE.test(value.slice(1, -1)));
}

export function createGisarWmsParcelSource(descriptor, { fetchImpl = globalThis.fetch, timeoutMs = 15000,
    maxResponseBytes = MAX_BYTES } = {}) {
    if (descriptor?.id !== GISAR_SOURCE_ID || descriptor.adapter !== 'kg-gisar-wms' || descriptor.endpoint !== GISAR_ENDPOINT
        || descriptor.layer !== LAYER || descriptor.idPrefix !== PREFIX || descriptor.idField !== 'propcode'
        || descriptor.outFields?.length !== 1 || descriptor.outFields[0] !== 'propcode'
        || typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 45000
        || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > MAX_BYTES) {
        throw new Error('Invalid GISAR cadastral descriptor.');
    }
    const projection = proj4('EPSG:4326', 'EPSG:3857');
    const result = (features, queryType, extra = {}) => ({ type: 'FeatureCollection', features,
        sourceId: descriptor.id, complete: true, returnsWGS84: true, queryType, ...extra });

    function geometryToWgs84(geometry) {
        try {
            if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) throw invalid();
            const walk = value => {
                if (!Array.isArray(value) || !value.length) throw invalid();
                if (typeof value[0] === 'number') {
                    if (value.length !== 2 || value.some(x => !Number.isFinite(x) || Math.abs(x) > 20037508.34278925)) throw invalid();
                    return projection.inverse(value);
                }
                return value.map(walk);
            };
            const output = { type: geometry.type, coordinates: walk(geometry.coordinates) };
            if (!validateGeometry(output)) throw invalid();
            return output;
        } catch { throw invalid('invalid parcel geometry'); }
    }

    async function request(parameters, signal) {
        const url = new URL(GISAR_ENDPOINT);
        for (const [key, value] of Object.entries({ ...BASE, ...parameters })) url.searchParams.set(key, String(value));
        if (!isGisarParcelUrl(url)) throw inputError('Invalid GISAR parcel query.');
        const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
        try {
            const response = await fetchImpl(url.href, { method: 'GET', credentials: 'omit', redirect: 'error',
                headers: { Accept: 'application/geo+json' }, signal: combined });
            if (!response.ok) throw providerHttpError(response);
            if (Number(response.headers.get('content-length')) > maxResponseBytes) { await response.body?.cancel(); throw invalid(); }
            const reader = response.body?.getReader();
            if (!reader) throw invalid();
            const chunks = []; let size = 0;
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
                || payload.features.length >= Number(parameters.FEATURE_COUNT) || payload.error || payload.exceededTransferLimit
                || !geoJsonResponseCrsMatches(payload.crs, 3857)) throw invalid('an invalid, truncated or wrong-CRS feature collection');
            const seen = new Set();
            return payload.features.map(row => {
                const code = row?.properties?.['Код ЕНИ'];
                if (typeof code !== 'string' || !CODE.test(code) || seen.has(code)) throw invalid('invalid or duplicate native ENI codes');
                seen.add(code);
                // WMS ignores PROPERTYNAME; incidental attributes are discarded immediately.
                return canonicalParcelFeature(descriptor, { type: 'Feature', geometry: geometryToWgs84(row.geometry),
                    properties: { propcode: code } }, code);
            });
        } catch (error) {
            if (signal?.aborted) throw signal.reason;
            if (combined.aborted) throw upstreamError('GISAR parcel provider timed out.', 504);
            if (error.status) throw error;
            throw upstreamError('GISAR parcel provider is unavailable.');
        }
    }

    async function queryIds(ids, { signal } = {}) {
        if (!Array.isArray(ids) || ids.length > 80 || ids.some(id => typeof id !== 'string'
            || !id.startsWith(PREFIX) || !CODE.test(id.slice(PREFIX.length)))) throw inputError('Expected canonical GISAR ENI parcel codes.');
        const unique = [...new Set(ids)];
        if (!unique.length) return result([], 'ids', { absentIds: [] });
        const values = unique.map(id => `'${id.slice(PREFIX.length)}'`).join(' , ');
        const features = await request({ FILTER: `${LAYER}:"propcode" IN ( ${values} )`, FEATURE_COUNT: unique.length + 1 }, signal);
        if (features.some(row => !unique.includes(row.id))) throw invalid();
        const found = new Set(features.map(row => row.id));
        return result(features, 'ids', { absentIds: unique.filter(id => !found.has(id)) });
    }

    async function queryBounds(bounds, { signal } = {}) {
        validateBounds(bounds, 1, { maxBboxWidthM: 2000, maxBboxHeightM: 2000 });
        const a = projection.forward(bounds.slice(0, 2)), b = projection.forward(bounds.slice(2));
        // The layer is published at scales 100..20000. Pad only the query envelope
        // to keep tiny reads in range; filter results back to the original scope without clipping.
        // Match the square WMS image: QGIS expands a non-square extent to the image's
        // aspect ratio, returning legitimate candidates outside its shorter axis.
        const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2;
        const halfSize = Math.max(8, (b[0] - a[0]) / 2, (b[1] - a[1]) / 2);
        const projected = [cx - halfSize, cy - halfSize, cx + halfSize, cy + halfSize];
        const pixels = Math.max(128, Math.ceil(halfSize * 2));
        const rows = await request({ FILTER: LAND_FILTER, FEATURE_COUNT: MAX_COUNT,
            BBOX: projected.join(','), WIDTH: pixels, HEIGHT: pixels }, signal);
        // QGIS searches an envelope transformed to the layer CRS. Live Osh reads
        // include valid candidates outside the requested EPSG:3857 rectangle.
        // Spatial scope belongs to this exact full-polygon predicate, not to an
        // assumed provider envelope. Identity, geometry and transfer checks above
        // still apply to every candidate; no polygon is clipped or repaired.
        const scope = bboxPolygon(bounds);
        return result(rows.filter(row => booleanIntersects(feature(row.geometry), scope)), 'bounds');
    }
    async function queryPoint(position, options) {
        if (!Array.isArray(position) || position.length !== 2 || !position.every(Number.isFinite)
            || Math.abs(position[0]) > 180 || Math.abs(position[1]) >= 85) throw inputError('Expected WGS84 [longitude, latitude].');
        const [x, y] = position;
        const read = await queryBounds([x - 0.000001, y - 0.000001, x + 0.000001, y + 0.000001], options);
        return result(read.features.filter(row => booleanPointInPolygon(point(position), feature(row.geometry))), 'point');
    }
    async function queryGeometry(geometry, options) {
        if (!validateGeometry(geometry)) throw inputError('Expected a WGS84 polygon.');
        const read = await queryBounds(bbox(feature(geometry)), options);
        return result(read.features.filter(row => booleanIntersects(feature(row.geometry), feature(geometry))), 'geometry');
    }
    return Object.freeze({ queryIds, queryBounds, queryPoint, queryGeometry });
}
