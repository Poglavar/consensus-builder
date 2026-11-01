// NSMaps' anonymous public MapGuide route. No login, attributes or geometry repair.
import proj4 from 'proj4';
import { SaxesParser } from 'saxes';
import { bbox, bboxPolygon, booleanIntersects, feature } from '@turf/turf';
import { parseKeralaWktPolygon } from './kerala-wkt.js';
import { concatBytes } from './byte-utils.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';

export const NS_SOURCE_ID = 'rs-novi-sad-mapanovisad-katastar';
export const NS_ENDPOINT = 'http://www.mapanovisad.rs/mapserver2015/mapagent/mapagent.fcgi';
export const NS_VIEWER = 'http://www.mapanovisad.rs/mapserver2015/nsmaps/';
export const NS_PROJECTION = '+proj=tmerc +lat_0=0 +lon_0=21 +k=0.9999 +x_0=7500000 +y_0=0 +ellps=bessel +units=m +no_defs';
const PREFIX = 'RS-NS-FID-', RESOURCE = 'Library://ZigLocations/Data/Topobase_1.FeatureSource';
const nativeId = value => typeof value === 'string' && /^[1-9]\d{0,14}$/.test(value) && Number.isSafeInteger(Number(value));
const fail = () => { throw upstreamError('MapGuide returned malformed, excessive or unsupported parcel data.'); };
const badInput = () => { throw upstreamError('Invalid MapGuide parcel query.', 400); };
export const isNoviSadSource = d => d?.id === NS_SOURCE_ID && d.adapter === 'mapguide-selectfeatures' && d.endpoint === NS_ENDPOINT;

// Transport-level allowlist, checked again after the browser envelope is decoded.
export function isNoviSadPublicRequest(target, method = 'GET', body) {
    if (!(target instanceof URL)) return false;
    if (target.href === NS_VIEWER) return method === 'GET' && body === undefined;
    if (target.href !== NS_ENDPOINT || method !== 'POST' || typeof body !== 'string' || body.length > 16384) return false;
    const p = new URLSearchParams(body);
    const fixed = { OPERATION: 'SELECTFEATURES', VERSION: '1.0.0', RESOURCEID: RESOURCE,
        CLASSNAME: 'JPOJOB:KAT_PARCELA', FORMAT: 'text/xml' };
    const keys = [...Object.keys(fixed), 'SESSION', 'PROPERTIES', 'FILTER'];
    if ([...p.keys()].length !== keys.length || keys.some(key => p.getAll(key).length !== 1)
        || Object.entries(fixed).some(([key,value]) => p.get(key) !== value)
        || !/^[a-zA-Z0-9_-]{20,150}$/.test(p.get('SESSION') || '') || !['FID','GEOM'].includes(p.get('PROPERTIES'))) return false;
    const filter = p.get('FILTER');
    const exact = /^FID = ([1-9]\d{0,14})$/.exec(filter);
    if (exact) return nativeId(exact[1]);
    if (p.get('PROPERTIES') !== 'FID') return false;
    const polygon = /^GEOM ENVELOPEINTERSECTS GeomFromText\('POLYGON \(\(([^()']+)\)\)'\)$/.exec(filter);
    if (!polygon) return false;
    const points = polygon[1].split(',').map(pair => pair.split(' ').map(Number));
    if (points.length !== 5 || points.some(pair => pair.length !== 2 || pair.some(n => !Number.isFinite(n)))) return false;
    const [[w,s],[e,s2],[e2,n],[w2,n2],[w3,s3]] = points;
    return w === w2 && w === w3 && e === e2 && s === s2 && s === s3 && n === n2
        && w >= 7389000 && e <= 7430000 && s >= 5003000 && n <= 5033000
        && e > w && n > s && e-w <= 1500 && n-s <= 1500;
}

export function parseMapGuideFeatures(xml, property, limit = 200) {
    const parser = new SaxesParser({ xmlns: true }), values = [], stack = [];
    let name = '', value = '', root = '', closed = false, inProperty = false, features = 0, containers = 0;
    parser.on('doctype', fail); parser.on('error', fail);
    parser.on('opentag', tag => {
        stack.push(tag.local);
        if (stack.length === 1) root = tag.local;
        if (stack.join('/') === 'FeatureSet/Features') containers++;
        if (stack.join('/') === 'FeatureSet/Features/Feature') features++;
        if (stack.join('/') === 'FeatureSet/Features/Feature/Property') { inProperty = true; name = ''; value = ''; }
    });
    parser.on('text', text => {
        if (!inProperty) return;
        if (stack.at(-1) === 'Name') name += text;
        if (stack.at(-1) === 'Value') value += text;
    });
    parser.on('closetag', tag => {
        if (inProperty && tag.local === 'Property') {
            if (name !== property || !value.trim() || values.length >= limit) fail();
            values.push(value.trim()); inProperty = false;
        }
        if (stack.length === 1) closed = true;
        stack.pop();
    });
    parser.write(xml).close();
    if (root !== 'FeatureSet' || !closed || containers !== 1 || features !== values.length) fail();
    return values;
}

export function createMapGuideParcelSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    if (!isNoviSadSource(descriptor) || descriptor.idPrefix !== PREFIX || descriptor.idField !== 'FID'
        || descriptor.geometryField !== 'GEOM' || descriptor.resourceId !== RESOURCE
        || descriptor.className !== 'JPOJOB:KAT_PARCELA' || descriptor.outFields?.length !== 1 || descriptor.outFields[0] !== 'FID'
        || descriptor.nativeProjection !== NS_PROJECTION) throw new Error('Invalid NSMaps parcel descriptor.');
    const maxFeatures = descriptor.maxFeatures ?? 200;
    if (!Number.isSafeInteger(maxFeatures) || maxFeatures < 1 || maxFeatures > 500) throw new Error('Invalid NSMaps feature limit.');
    const projection = proj4(NS_PROJECTION, 'EPSG:4326');
    const result = (features, queryType, extra = {}) => ({ type: 'FeatureCollection', features, sourceId: NS_SOURCE_ID,
        complete: true, returnsWGS84: true, queryType, ...extra });
    const budget = signal => ({ bytes: 0, requests: 0, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000) });
    async function request(url, body, operation) {
        if (++operation.requests > 1002 || !isNoviSadPublicRequest(new URL(url), body === undefined ? 'GET' : 'POST', body)) fail();
        const response = await fetchImpl(url, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', credentials: 'omit',
            signal: AbortSignal.any([operation.signal, AbortSignal.timeout(20000)]),
            headers: { Accept: 'text/xml, text/html', ...(body === undefined ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }) }, body });
        if (!response.ok) { await response.body?.cancel(); throw providerHttpError(response); }
        const reader = response.body?.getReader(); if (!reader) fail();
        const chunks = []; let size = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read(); if (done) break;
                size += value.byteLength; operation.bytes += value.byteLength;
                if (size > 1024 * 1024 || operation.bytes > 16 * 1024 * 1024) fail();
                chunks.push(value);
            }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        return new TextDecoder('utf-8', { fatal: true }).decode(concatBytes(chunks, size));
    }
    async function session(operation) {
        const html = await request(NS_VIEWER, undefined, operation);
        const value = /[?&]SESSION=([a-zA-Z0-9_-]{20,150})&(?:amp;)?WEBLAYOUT=/.exec(html)?.[1];
        if (!value) fail();
        return value;
    }
    async function select(sessionId, property, filter, operation, limit = maxFeatures) {
        // MAXFEATURES is ignored by this installation. Bounded filters, streamed byte and
        // row limits protect every query; reaching a local limit fails rather than truncates.
        const body = new URLSearchParams({ OPERATION: 'SELECTFEATURES', VERSION: '1.0.0', SESSION: sessionId,
            RESOURCEID: RESOURCE, CLASSNAME: 'JPOJOB:KAT_PARCELA', PROPERTIES: property, FILTER: filter, FORMAT: 'text/xml' }).toString();
        return parseMapGuideFeatures(await request(NS_ENDPOINT, body, operation), property, limit);
    }
    const canonical = (wkt, id) => {
        const geometry = parseKeralaWktPolygon(wkt);
        const map = coordinates => typeof coordinates[0] === 'number' ? projection.forward(coordinates) : coordinates.map(map);
        geometry.coordinates = map(geometry.coordinates);
        if (!validateGeometry(geometry)) fail();
        return canonicalParcelFeature(descriptor, { geometry, properties: { FID: id } }, id);
    };
    async function readGeometry(sessionId, id, operation) {
        const values = await select(sessionId, 'GEOM', `FID = ${id}`, operation, 2);
        if (values.length !== 1) fail();
        return canonical(values[0], id);
    }
    async function queryIds(ids, { signal } = {}) {
        if (!Array.isArray(ids) || !ids.length || ids.length > maxFeatures || new Set(ids).size !== ids.length
            || ids.some(id => typeof id !== 'string' || !id.startsWith(PREFIX) || !nativeId(id.slice(PREFIX.length)))) badInput();
        const operation = budget(signal), sessionId = await session(operation), features = [], absentIds = [];
        for (const id of ids) {
            const native = id.slice(PREFIX.length), values = await select(sessionId, 'FID', `FID = ${native}`, operation, 2);
            if (values.length > 1 || values.some(value => value !== native)) fail();
            if (!values.length) absentIds.push(id);
            else features.push(await readGeometry(sessionId, native, operation));
        }
        return result(features, 'ids', { absentIds });
    }
    async function queryBounds(bounds, { signal } = {}) {
        validateBounds(bounds, descriptor.maxBboxKm2 ?? 0.2);
        const projected = [];
        for (let i = 0; i <= 16; i++) {
            const [w,s,e,n] = bounds, t = i / 16;
            projected.push(...[[w+(e-w)*t,s],[w+(e-w)*t,n],[w,s+(n-s)*t],[e,s+(n-s)*t]].map(p => projection.inverse(p)));
        }
        const w = Math.min(...projected.map(p => p[0])), s = Math.min(...projected.map(p => p[1]));
        const e = Math.max(...projected.map(p => p[0])), n = Math.max(...projected.map(p => p[1]));
        // Constrain this municipal service; no national/unbounded reads.
        if (w < 7389000 || e > 7430000 || s < 5003000 || n > 5033000) return result([], 'bounds');
        const operation = budget(signal), sessionId = await session(operation);
        const filter = `GEOM ENVELOPEINTERSECTS GeomFromText('POLYGON ((${w} ${s},${e} ${s},${e} ${n},${w} ${n},${w} ${s}))')`;
        const ids = await select(sessionId, 'FID', filter, operation);
        if (ids.some(id => !nativeId(id)) || new Set(ids).size !== ids.length) fail();
        const features = [];
        for (const id of ids) features.push(await readGeometry(sessionId, id, operation));
        const window = bboxPolygon(bounds);
        return result(features.filter(f => booleanIntersects(f, window)), 'bounds');
    }
    async function queryGeometry(geometry, options) {
        if (!validateGeometry(geometry)) badInput();
        const target = feature(geometry), read = await queryBounds(bbox(target), options);
        return { ...read, queryType: 'geometry', features: read.features.filter(f => booleanIntersects(f, target)) };
    }
    return Object.freeze({ queryBounds, queryIds, queryGeometry });
}

export function parseMapGuideOperation(body) {
    let data; try { data = JSON.parse(body); } catch { badInput(); }
    if (!data || !['queryBounds', 'queryIds', 'queryGeometry'].includes(data._mapguideOperation)
        || Object.keys(data).length !== 2 || !Object.hasOwn(data, 'input')) badInput();
    return data;
}
export function createMapGuideBrowserSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    createMapGuideParcelSource(descriptor, { fetchImpl });
    const method = name => async (input, { signal } = {}) => {
        const response = await fetchImpl(NS_ENDPOINT, { method: 'POST', signal, redirect: 'error',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ _mapguideOperation: name, input }) });
        if (!response.ok) throw providerHttpError(response);
        // The trusted relay also caps its streamed reply. Validate IDs/geometry before presenting it.
        const reader = response.body?.getReader(); if (!reader) fail();
        const chunks = []; let size = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read(); if (done) break;
                size += value.byteLength;
                if (size > 1024 * 1024) fail();
                chunks.push(value);
            }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(concatBytes(chunks, size)));
        if (data.type !== 'FeatureCollection' || data.sourceId !== NS_SOURCE_ID || data.complete !== true
            || !Array.isArray(data.features) || data.features.length > descriptor.maxFeatures
            || data.features.some(f => !validateGeometry(f.geometry) || f.id !== PREFIX + f.properties?.sourceParcelId
                || !nativeId(f.properties?.sourceParcelId) || f.properties?.sourceId !== NS_SOURCE_ID)) fail();
        return data;
    };
    return Object.fromEntries(['queryBounds', 'queryIds', 'queryGeometry'].map(name => [name, method(name)]));
}
