// Read a bounded public cadastral report without executing its JavaScript or retaining report attributes.
import proj4 from 'proj4';
import { bbox, bboxPolygon, booleanIntersects, booleanPointInPolygon, feature, point } from '@turf/turf';
import { concatBytes } from './byte-utils.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';

export const YAROSLAVL_REPORT_ENDPOINT = 'https://xn----7sbaabako6cg4bxggpi0t.com/кадастровая_карта/5c2a76f832ec072654500bf985a90d6d/yaroslavskaya-oblast-yaroslavl-kedrova-6';
export const YAROSLAVL_REPORT_ID = '76:23:030701:29';
// Published, unfitted MSK-76 zone 1 parameters. The report's conflicting MSK-33 label
// and the datum operation still require independent second-pass control evidence.
export const YAROSLAVL_MSK76 = '+proj=tmerc +lat_0=0 +lon_0=38.55 +k=1 +x_0=1250000 +y_0=-6014743.504 +ellps=krass +towgs84=23.57,-140.95,-79.8,0,0.35,0.79,-0.22 +units=m +no_defs';
const PREFIX = 'RU-YAROSLAVL-REPORT-';
const fail = message => { throw upstreamError(`Cadastral report: ${message}`); };

export function parseCadastralReport(html, nativeId) {
    if (typeof html !== 'string' || !html.includes('Сведения о характерных точках границы земельного участка')
        || !html.includes('Кадастровый номер') || !html.includes(`>${nativeId}<`)) fail('parcel identity or cadastral boundary section is missing.');
    const values = new Map();
    for (const match of html.matchAll(/Coords1\[(\d+)\]\[(\d+)\]\[(\d+)\]\s*=\s*([^;]+);/g)) {
        const [, part, ring, index, literal] = match;
        if (part !== '0' || ring !== '0') fail('multiple contours require an evidenced topology contract.');
        if (index === '0') continue;
        if (!/^\d+(?:\.\d+)?$/.test(literal.trim()) || values.has(Number(index))) fail('invalid coordinate assignment.');
        values.set(Number(index), Number(literal));
    }
    if (values.size < 8 || values.size % 2 || values.size > 20000) fail('missing or oversized coordinate ring.');
    const coordinates = [];
    for (let index = 1; index <= values.size; index += 2) {
        if (!values.has(index) || !values.has(index + 1)) fail('coordinate sequence has gaps.');
        coordinates.push([values.get(index), values.get(index + 1)]);
    }
    if (coordinates[0][0] !== coordinates.at(-1)[0] || coordinates[0][1] !== coordinates.at(-1)[1]) fail('source ring is not closed.');
    return { type: 'Polygon', coordinates: [coordinates] };
}

export function createRuCadastralReportSource(descriptor, { fetchImpl = globalThis.fetch, timeoutMs = 20000,
    maxResponseBytes = descriptor.maxResponseBytes ?? 1048576 } = {}) {
    if (descriptor.id !== 'ru-yaroslavl-kadastrovaya-karta-com-report' || descriptor.adapter !== 'ru-cadastral-report'
        || descriptor.endpoint !== YAROSLAVL_REPORT_ENDPOINT || descriptor.idPrefix !== PREFIX
        || descriptor.nativeId !== YAROSLAVL_REPORT_ID || descriptor.nativeProjection !== YAROSLAVL_MSK76
        || descriptor.outFields?.length !== 1 || descriptor.outFields[0] !== 'cadnum'
        || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 16 * 1024 * 1024) {
        throw new Error('Invalid bounded Yaroslavl cadastral report descriptor.');
    }
    const result = (features, queryType, extra = {}) => ({ type: 'FeatureCollection', sourceId: descriptor.id,
        features, queryType, complete: true, returnsWGS84: true, coverageScope: 'single-published-historic-report',
        areaCompleteness: false, ...extra });
    let spatialRead, spatialReadAt = 0;
    // Adjacent viewport cells share a short in-memory read. Exact reads always refetch.
    function readSpatial(signal) {
        if (!spatialRead || Date.now() - spatialReadAt >= 30000) {
            spatialReadAt = Date.now();
            spatialRead = read(signal).catch(error => { spatialRead = null; throw error; });
        }
        return spatialRead;
    }
    async function read(signal) {
        const timeout = AbortSignal.timeout(timeoutMs);
        const response = await fetchImpl(new URL(descriptor.endpoint).href, { method: 'GET', credentials: 'omit',
            redirect: 'error', headers: { Accept: 'text/html' }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
        if (!response.ok) { await response.body?.cancel(); throw providerHttpError(response); }
        const reader = response.body?.getReader();
        if (!reader) fail('missing response stream.');
        const chunks = []; let size = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > maxResponseBytes) { await reader.cancel(); fail('response exceeded byte limit.'); }
                chunks.push(value);
            }
        } finally { reader.releaseLock(); }
        const native = parseCadastralReport(new TextDecoder('utf-8', { fatal: true }).decode(concatBytes(chunks, size)), descriptor.nativeId);
        // Source wire pairs are northing,easting; transform vertices only, preserving order and closure.
        const geometry = { type: 'Polygon', coordinates: native.coordinates.map(ring => ring.map(([n, e]) =>
            proj4(descriptor.nativeProjection, 'EPSG:4326', [e, n]))) };
        if (!validateGeometry(geometry)) fail('unusable projected polygon.');
        return canonicalParcelFeature(descriptor, { type: 'Feature', geometry, properties: { cadnum: descriptor.nativeId } }, descriptor.nativeId);
    }
    async function queryIds(ids, { signal } = {}) {
        const expected = PREFIX + descriptor.nativeId;
        if (!Array.isArray(ids) || ids.length > 80 || ids.some(id => typeof id !== 'string'
            || !/^RU-YAROSLAVL-REPORT-\d{2}:\d{2}:\d{6,7}:\d+$/.test(id))) throw new Error('Expected canonical cadastral report IDs.');
        const unique = [...new Set(ids)];
        // Unknown IDs are outside this report's contract, not evidence that a cadastral parcel is absent.
        if (unique.some(id => id !== expected)) fail('requested ID is outside the published-report scope.');
        return result(unique.length ? [await read(signal)] : [], 'ids', { absentIds: [] });
    }
    async function queryBounds(bounds, { signal } = {}) {
        validateBounds(bounds, 25);
        const row = await readSpatial(signal);
        return result(booleanIntersects(feature(row.geometry), bboxPolygon(bounds)) ? [row] : [], 'bounds');
    }
    async function queryPoint(position, options) {
        if (!Array.isArray(position) || position.length !== 2 || !position.every(Number.isFinite)
            || Math.abs(position[0]) > 180 || Math.abs(position[1]) > 90) throw new Error('Expected WGS84 point.');
        const row = await readSpatial(options?.signal);
        return result(booleanPointInPolygon(point(position), feature(row.geometry)) ? [row] : [], 'point');
    }
    async function queryGeometry(geometry, options) {
        if (!validateGeometry(geometry)) throw new Error('Expected WGS84 polygon.');
        const rows = await queryBounds(bbox(feature(geometry)), options);
        return result(rows.features.filter(row => booleanIntersects(feature(row.geometry), feature(geometry))), 'geometry');
    }
    return Object.freeze({ queryIds, queryBounds, queryPoint, queryGeometry });
}
