// Bounded Sofia cadastre reads: native IDs over WFS 1.1 and advertised WFS 2 page links.
import proj4 from 'proj4';
import { SaxesParser } from 'saxes';
import { bbox, bboxPolygon, booleanIntersects, feature } from '@turf/turf';
import { SOFIA_GML_SCHEMA, parseGmlParcels } from './gml-parcel-reader.js';
import { concatBytes } from './byte-utils.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';

export const SOFIA_SOURCE_ID = 'bg-sofia-isofmap-cad-immovable-wfs';
export const SOFIA_ENDPOINT = 'http://www.isofmap.bg/owsmap';
const PREFIX = 'BG-SOFIA-ISOFMAP-CAD-IMMOVABLE|cadnumber|';
const NATIVE_ID = /^\d{5}\.\d+\.\d+$/;
const BASE = Object.freeze({ SERVICE: 'WFS', REQUEST: 'GetFeature', TYPENAME: 'cad_immovable',
    OUTPUTFORMAT: 'GML3', SRSNAME: 'EPSG:7801', PROPERTYNAME: 'ms:cadnumber,ms:msGeometry' });
const fail = message => { throw upstreamError(message); };
const inputError = message => Object.assign(new Error(message), { status: 400 });
const exactFilter = id => '<ogc:Filter xmlns:ogc="http://www.opengis.net/ogc" xmlns:ms="http://mapserver.gis.umn.edu/mapserver">'
    + '<ogc:PropertyIsEqualTo><ogc:PropertyName>ms:cadnumber</ogc:PropertyName><ogc:Literal>' + id
    + '</ogc:Literal></ogc:PropertyIsEqualTo></ogc:Filter>';

// The published HTTP route is allowed only for these fixed, safe, read-only requests.
// The relay uses this same predicate before DNS resolution and again at transport.
export function isSofiaParcelUrl(url) {
    if (!(url instanceof URL) || url.origin !== new URL(SOFIA_ENDPOINT).origin
        || url.pathname !== '/owsmap' || url.username || url.password || url.hash) return false;
    const p = url.searchParams;
    const allowed = new Set([...Object.keys(BASE), 'VERSION', 'MAXFEATURES', 'COUNT', 'STARTINDEX', 'BBOX', 'FILTER']);
    if ([...p.keys()].some(key => !allowed.has(key) || p.getAll(key).length !== 1)
        || Object.entries(BASE).some(([key, value]) => p.get(key) !== value)) return false;
    if (p.get('VERSION') === '1.1.0') {
        const f = p.get('FILTER') || '';
        const id = /<ogc:Literal>(\d{5}\.\d+\.\d+)<\/ogc:Literal>/.exec(f)?.[1];
        return Boolean(id && f === exactFilter(id) && p.get('MAXFEATURES') === '2'
            && !['COUNT', 'STARTINDEX', 'BBOX'].some(key => p.has(key)));
    }
    if (p.get('VERSION') !== '2.0.0' || p.has('FILTER') || p.has('MAXFEATURES')) return false;
    const count = p.get('COUNT'), offset = p.get('STARTINDEX');
    if (!/^[1-9]\d*$/.test(count || '') || Number(count) > 100
        || !/^(0|[1-9]\d*)$/.test(offset || '') || Number(offset) > 1000) return false;
    const values = (p.get('BBOX') || '').split(',');
    const b = values.slice(0, 4).map(Number);
    return values.length === 5 && values[4] === 'EPSG:7801' && b.every(Number.isFinite)
        && b[0] >= 4500000 && b[2] <= 5000000 && b[1] >= 200000 && b[3] <= 1000000
        && b[0] < b[2] && b[1] < b[3] && b[2] - b[0] <= 3000 && b[3] - b[1] <= 3000;
}

function pageMetadata(xml) {
    const parser = new SaxesParser({ xmlns: true });
    let depth = 0, metadata;
    parser.on('doctype', () => fail('Sofia WFS document types are forbidden.'));
    parser.on('error', () => fail('Sofia WFS returned malformed XML.'));
    parser.on('opentag', tag => {
        if (++depth !== 1) return;
        if (tag.local !== 'FeatureCollection' || !['http://www.opengis.net/wfs', 'http://www.opengis.net/wfs/2.0'].includes(tag.uri)) {
            fail('Sofia WFS returned an exception or a foreign document.');
        }
        metadata = Object.fromEntries(Object.values(tag.attributes).filter(a => !a.uri).map(a => [a.local, a.value]));
    });
    parser.on('closetag', () => depth--);
    parser.write(xml).close();
    if (!metadata || depth) fail('Sofia WFS returned incomplete XML.');
    return metadata;
}

export function createSofiaParcelSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    if (descriptor?.id !== SOFIA_SOURCE_ID || descriptor.adapter !== 'sofia-isofmap'
        || descriptor.endpoint !== SOFIA_ENDPOINT || descriptor.featureType !== 'cad_immovable'
        || descriptor.idPrefix !== PREFIX || descriptor.idField !== 'cadnumber'
        || descriptor.geometryField !== 'msGeometry' || descriptor.responseCrs !== 'EPSG:7801'
        || descriptor.version !== '1.1.0' || descriptor.boundsVersion !== '2.0.0'
        || descriptor.parcelNumberField !== 'cadnumber' || descriptor.idType !== 'string'
        || descriptor.outFields?.length !== 1 || descriptor.outFields[0] !== 'cadnumber'
        || typeof fetchImpl !== 'function') throw new Error('Invalid Sofia cadastral descriptor.');
    const maxFeatures = descriptor.maxFeatures ?? 500;
    const pageSize = descriptor.pageSize ?? 1;
    const maxBytes = descriptor.maxResponseBytes ?? 1024 * 1024;
    const totalBytes = descriptor.maxTotalResponseBytes ?? 16 * 1024 * 1024;
    if (!Number.isSafeInteger(maxFeatures) || maxFeatures < 1 || maxFeatures > 1000
        || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100
        || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024
        || !Number.isSafeInteger(totalBytes) || totalBytes < 1 || totalBytes > 16 * 1024 * 1024) {
        throw new Error('Invalid Sofia cadastral limits.');
    }
    const result = (features, queryType, extra = {}) => ({ type: 'FeatureCollection', features,
        sourceId: descriptor.id, complete: true, returnsWGS84: true, queryType, ...extra });
    const makeUrl = params => new URL(`${SOFIA_ENDPOINT}?${new URLSearchParams({ ...BASE, ...params })}`);

    async function request(url, budget, signal) {
        if (!isSofiaParcelUrl(url)) throw inputError('Invalid Sofia parcel request.');
        if (++budget.requests > 1001) fail('Sofia parcel request budget exceeded.');
        const timeout = Math.min(descriptor.timeoutMs ?? 15000, budget.deadline - Date.now());
        if (timeout <= 0) fail('Sofia parcel operation timed out.');
        const timed = AbortSignal.timeout(timeout);
        const combined = signal ? AbortSignal.any([timed, signal]) : timed;
        const response = await fetchImpl(url.href, { signal: combined, method: 'GET', credentials: 'omit',
            redirect: 'error', headers: { Accept: 'application/xml, text/xml' } });
        if (!response.ok) throw providerHttpError(response);
        const chunks = [];
        let size = 0;
        const reader = response.body?.getReader();
        if (!reader) fail('Sofia WFS returned no response stream.');
        try {
            for (;;) {
                const item = await reader.read();
                if (item.done) break;
                size += item.value.byteLength;
                if (size > maxBytes || budget.bytes + size > totalBytes) fail('Sofia WFS response exceeds byte limit.');
                if (Date.now() >= budget.deadline) fail('Sofia parcel operation timed out.');
                chunks.push(item.value);
            }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        budget.bytes += size;
        const xml = new TextDecoder('utf-8', { fatal: true }).decode(concatBytes(chunks, size));
        const metadata = pageMetadata(xml);
        const parsed = await parseGmlParcels(xml, { schema: SOFIA_GML_SCHEMA, maxBytes, maxFeatures, signal: combined });
        if (parsed.duplicateNativeCount) fail('Sofia WFS repeats a native cadastral identifier.');
        return { ...parsed, metadata };
    }
    const budget = () => ({ bytes: 0, requests: 0, deadline: Date.now() + 120000 });
    const canonical = f => canonicalParcelFeature(descriptor, f, f.id);

    async function queryIds(ids, { signal } = {}) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80 || new Set(ids).size !== ids.length
            || ids.some(id => typeof id !== 'string' || !id.startsWith(PREFIX) || !NATIVE_ID.test(id.slice(PREFIX.length)))) {
            throw inputError('Expected safe Sofia cadastral IDs.');
        }
        const operation = budget(), features = [], absentIds = [];
        for (const id of ids) {
            const native = id.slice(PREFIX.length);
            const read = await request(makeUrl({ VERSION: '1.1.0', MAXFEATURES: '2', FILTER: exactFilter(native) }), operation, signal);
            if (read.features.length > 1 || read.features.some(f => f.id !== native)) fail('Sofia WFS ignored the exact cadastral ID filter.');
            if (read.features.length) features.push(canonical(read.features[0]));
            else absentIds.push(id);
        }
        return result(features, 'ids', { absentIds });
    }

    async function queryBounds(bounds, { signal } = {}) {
        validateBounds(bounds, descriptor.maxBboxKm2 ?? 1);
        const projection = proj4('EPSG:4326', 'EPSG:7801'), points = [];
        for (let i = 0; i <= 16; i++) {
            const t = i / 16, [w, s, e, n] = bounds;
            points.push([w + (e - w) * t, s], [w + (e - w) * t, n], [w, s + (n - s) * t], [e, s + (n - s) * t]);
        }
        const projected = points.map(p => projection.forward(p));
        const nativeBox = [Math.min(...projected.map(p => p[1])), Math.min(...projected.map(p => p[0])),
            Math.max(...projected.map(p => p[1])), Math.max(...projected.map(p => p[0]))];
        const wireBox = [...nativeBox, 'EPSG:7801'].join(',');
        const operation = budget(), byId = new Map();
        let offset = 0;
        for (;;) {
            const url = makeUrl({ VERSION: '2.0.0', BBOX: wireBox, COUNT: String(pageSize), STARTINDEX: String(offset) });
            const read = await request(url, operation, signal);
            for (const f of read.features) {
                if (byId.has(f.id)) fail('Sofia WFS repeated a page or native ID.');
                byId.set(f.id, canonical(f));
                if (byId.size > maxFeatures) fail('Sofia parcel viewport exceeds feature limit.');
            }
            if (!read.metadata.next) {
                if (read.numberMatched !== undefined && read.numberMatched !== byId.size) fail('Sofia WFS returned an incomplete parcel set.');
                break;
            }
            const next = new URL(read.metadata.next);
            const nextOffset = Number(next.searchParams.get('STARTINDEX'));
            if (!isSofiaParcelUrl(next) || next.searchParams.get('BBOX') !== wireBox
                || !read.features.length || nextOffset !== offset + read.featureCount) fail('Sofia WFS returned an invalid continuation.');
            offset = nextOffset;
        }
        const window = bboxPolygon(bounds);
        return result([...byId.values()].filter(f => booleanIntersects(f, window)), 'bounds');
    }
    async function queryGeometry(geometry, options) {
        if (!validateGeometry(geometry)) throw inputError('Expected a WGS84 parcel polygon.');
        const target = feature(geometry);
        const read = await queryBounds(bbox(target), options);
        return { ...read, queryType: 'geometry', features: read.features.filter(f => booleanIntersects(f, target)) };
    }
    return { queryIds, queryBounds, queryGeometry };
}

// One browser operation holds one relay slot; only fresh bounded GETs reach iSofMap.
// The provider's one-feature pages must not consume the browser relay's per-minute budget.
export function parseSofiaRelayOperation(body) {
    let data;
    try { data = JSON.parse(body); } catch { throw inputError('Invalid Sofia relay operation.'); }
    if (!data || !['queryBounds', 'queryIds', 'queryGeometry'].includes(data._sofiaOperation)
        || Object.keys(data).length !== 2 || !Object.hasOwn(data, 'input')) throw inputError('Invalid Sofia relay operation.');
    return data;
}

export function createSofiaBrowserParcelSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    // Validate the same production profile on both sides of the relay.
    createSofiaParcelSource(descriptor, { fetchImpl });
    const operation = method => async (input, { signal } = {}) => {
        const response = await fetchImpl(SOFIA_ENDPOINT, { method: 'POST', signal, redirect: 'error',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ _sofiaOperation: method, input }) });
        if (!response.ok) throw providerHttpError(response);
        const reader = response.body?.getReader(), chunks = [];
        let size = 0;
        if (!reader) fail('Sofia relay returned no response stream.');
        try {
            for (;;) {
                const item = await reader.read();
                if (item.done) break;
                size += item.value.byteLength;
                if (size > (descriptor.maxResponseBytes ?? 1048576)) fail('Sofia relay response exceeds byte limit.');
                chunks.push(item.value);
            }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(concatBytes(chunks, size)));
        if (data.type !== 'FeatureCollection' || data.sourceId !== SOFIA_SOURCE_ID || data.complete !== true
            || !Array.isArray(data.features) || data.features.length > (descriptor.maxFeatures ?? 500)
            || data.features.some(f => !validateGeometry(f.geometry) || f.id !== PREFIX + f.properties?.sourceParcelId
                || f.properties.sourceId !== SOFIA_SOURCE_ID || !NATIVE_ID.test(f.properties.sourceParcelId))) {
            fail('Sofia relay returned invalid parcel features.');
        }
        return data;
    };
    return Object.fromEntries(['queryBounds', 'queryIds', 'queryGeometry'].map(method => [method, operation(method)]));
}
