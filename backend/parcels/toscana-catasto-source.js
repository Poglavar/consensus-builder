// Tuscany: WFS native-ID locators and fresh, whole cadastral polygons from WMS GML.
// WFS bounding rectangles are never exposed as parcels or used as replacement geometry.
import { SaxesParser } from 'saxes';
import { bbox, bboxPolygon, booleanIntersects, booleanPointInPolygon, point } from '@turf/turf';
import { concatBytes } from './byte-utils.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';

export const TOSCANA_SOURCE = 'it-regione-toscana-geoscopio-catasto-particelle-wms';
export const TOSCANA_ENDPOINT = 'https://www502.regione.toscana.it/ows_catasto/com.rt.wms.RTmap/ows?map=owscatasto&';
const LAYER = 'rt_cat.idcatpart.rt', LOCATOR = 'rt_cat.idcatpart.bbox.rt', PREFIX = 'IT-TOSCANA-';
const GML = 'http://www.opengis.net/gml', OGR = 'http://ogr.maptools.org/', MS = 'http://mapserver.gis.umn.edu/mapserver';
const MAX_BYTES = 8 * 1024 * 1024, LIMIT = 501, PIXELS = 301;
const nativeId = value => typeof value === 'string' && /^[0-9]{1,16}$/.test(value);
const invalid = () => upstreamError('Tuscany returned invalid, conflicting, truncated or unresolved cadastral data.');
const inputError = () => upstreamError('Invalid Tuscany parcel query.', 400);
const children = (node, uri, name) => node.children.filter(child => child.uri === uri && child.name === name);
const one = (node, uri, name) => { const found = children(node, uri, name); if (found.length !== 1) throw invalid(); return found[0]; };
const attr = (node, name, uri = '') => Object.values(node.attrs).find(a => a.local === name && a.uri === uri)?.value;

function xmlTree(xml) {
    const parser = new SaxesParser({ xmlns: true }), stack = []; let root, count = 0;
    parser.on('doctype', () => { throw invalid(); });
    parser.on('opentag', tag => {
        if (++count > 250000 || stack.length > 24) throw invalid();
        const node = { name: tag.local, uri: tag.uri, attrs: tag.attributes, text: '', children: [] };
        if (stack.length) stack.at(-1).children.push(node); else root = node;
        stack.push(node);
    });
    parser.on('text', text => { if (stack.length) stack.at(-1).text += text; });
    parser.on('closetag', () => stack.pop());
    parser.on('error', () => { throw invalid(); });
    try { parser.write(xml).close(); } catch { throw invalid(); }
    return root;
}

// The public GFI response is multipart: parse its single OGR document, not the XSD part.
export function parseToscanaGml(body, descriptor) {
    const start = body.indexOf('<?xml'), end = body.indexOf('</ogr:FeatureCollection>');
    if (start < 0 || end < start || body.indexOf('<ogr:FeatureCollection', start) < 0
        || body.indexOf('</ogr:FeatureCollection>', end + 1) >= 0) throw invalid();
    const root = xmlTree(body.slice(start, end + '</ogr:FeatureCollection>'.length));
    if (root?.uri !== OGR || root.name !== 'FeatureCollection'
        || root.children.some(n => n.uri !== GML || !['boundedBy', 'featureMember'].includes(n.name))) throw invalid();
    const members = children(root, GML, 'featureMember');
    if (members.length > LIMIT) throw invalid();
    const seen = new Map();
    for (const member of members) {
        const row = one(member, OGR, LAYER), id = one(row, OGR, 'featureid').text.trim();
        if (member.children.length !== 1 || !nativeId(id)) throw invalid();
        const property = one(row, OGR, 'geometryProperty'), multi = one(property, GML, 'MultiPolygon');
        if (property.children.length !== 1 || attr(multi, 'srsName') !== 'EPSG:4326') throw invalid();
        const polygons = children(multi, GML, 'polygonMember');
        if (polygons.length !== multi.children.length) throw invalid();
        const coordinates = polygons.map(member => {
            const polygon = one(member, GML, 'Polygon');
            if (member.children.length !== 1) throw invalid();
            const boundaries = [one(polygon, GML, 'outerBoundaryIs'), ...children(polygon, GML, 'innerBoundaryIs')];
            if (boundaries.length !== polygon.children.length) throw invalid();
            return boundaries.map(boundary => {
                const ring = one(boundary, GML, 'LinearRing'), coord = one(ring, GML, 'coordinates');
                if (boundary.children.length !== 1 || ring.children.length !== 1 || coord.children.length
                    || !['.', undefined].includes(attr(coord, 'decimal')) || ![',', undefined].includes(attr(coord, 'cs'))
                    || ![' ', undefined].includes(attr(coord, 'ts'))) throw invalid();
                return coord.text.trim().split(/\s+/).map(pair => {
                    const values = pair.split(',');
                    if (values.length !== 2 || values.some(v => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(v))) throw invalid();
                    return values.map(Number);
                });
            });
        });
        const geometry = { type: 'MultiPolygon', coordinates };
        if (!validateGeometry(geometry)) throw invalid();
        const previous = seen.get(id);
        if (previous && JSON.stringify(previous.geometry) !== JSON.stringify(geometry)) throw invalid();
        if (!previous) seen.set(id, canonicalParcelFeature(descriptor, { geometry, properties: { featureid: id } }, id));
    }
    return { features: [...seen.values()], saturated: members.length >= LIMIT };
}

// PROPERTYNAME=pkuid suppresses all attributes and the broken WFS rectangle geometry.
// Its collection envelope is a locator only, with explicit EPSG:4326 latitude/longitude axes.
export function parseToscanaLocator(body, expected) {
    const root = xmlTree(body);
    if (root?.uri !== 'http://www.opengis.net/wfs' || root.name !== 'FeatureCollection') throw invalid();
    const members = children(root, GML, 'featureMember');
    if (members.length > 1) throw invalid();
    if (!members.length) return null;
    const row = one(members[0], MS, LOCATOR);
    if (members[0].children.length !== 1 || row.children.length !== 1 || one(row, MS, 'pkuid').text.trim() !== expected
        || attr(row, 'id', GML) !== `${LOCATOR}.${expected}`) throw invalid();
    const envelope = one(one(root, GML, 'boundedBy'), GML, 'Envelope');
    if (attr(envelope, 'srsName') !== 'urn:ogc:def:crs:EPSG::4326') throw invalid();
    const a = one(envelope, GML, 'lowerCorner').text.trim().split(/\s+/).map(Number);
    const b = one(envelope, GML, 'upperCorner').text.trim().split(/\s+/).map(Number);
    if (a.length !== 2 || b.length !== 2) throw invalid();
    const bounds = [a[1], a[0], b[1], b[0]];
    try { validateBounds(bounds, 100); } catch { throw invalid(); }
    return bounds;
}

export function createToscanaCatastoSource(descriptor, { fetchImpl = globalThis.fetch, timeoutMs = 30000,
    maxResponseBytes = MAX_BYTES } = {}) {
    if (descriptor?.id !== TOSCANA_SOURCE || descriptor.adapter !== 'toscana-catasto' || descriptor.endpoint !== TOSCANA_ENDPOINT
        || descriptor.layer !== LAYER || descriptor.locatorLayer !== LOCATOR || descriptor.idPrefix !== PREFIX
        || descriptor.idField !== 'featureid' || descriptor.outFields?.length !== 1 || descriptor.outFields[0] !== 'featureid'
        || typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 45000
        || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > MAX_BYTES) throw new Error('Invalid Tuscany cadastral descriptor.');
    const result = (features, queryType, extra = {}) => ({ type: 'FeatureCollection', sourceId: TOSCANA_SOURCE,
        complete: true, returnsWGS84: true, features, queryType, ...extra });

    async function request(parameters, signal) {
        const url = new URL(TOSCANA_ENDPOINT);
        for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value));
        const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
        const response = await fetchImpl(url.href, { method: 'GET', credentials: 'omit', redirect: 'error',
            headers: { Accept: 'text/xml, text/gml' }, signal: combined });
        if (!response.ok) { await response.body?.cancel(); throw providerHttpError(response); }
        if (Number(response.headers.get('content-length')) > maxResponseBytes) { await response.body?.cancel(); throw invalid(); }
        const reader = response.body?.getReader(); if (!reader) throw invalid();
        const chunks = []; let size = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read(); if (done) break;
                size += value.byteLength;
                if (size > maxResponseBytes) throw invalid();
                chunks.push(value);
            }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        try { return new TextDecoder('utf-8', { fatal: true }).decode(concatBytes(chunks, size)); } catch { throw invalid(); }
    }
    async function gfi(bounds, radius, signal) {
        const [w,s,e,n] = bounds;
        return parseToscanaGml(await request({ service: 'WMS', version: '1.3.0', request: 'GetFeatureInfo',
            layers: LAYER, query_layers: LAYER, styles: '', crs: 'EPSG:4326', bbox: [s,w,n,e].join(','),
            width: PIXELS, height: PIXELS, i: 150, j: 150, radius, feature_count: LIMIT,
            propertyname: 'featureid,geometryProperty', info_format: 'text/gml' }, signal), descriptor);
    }
    async function queryIds(ids, { signal } = {}) {
        if (!Array.isArray(ids) || ids.length > 80 || ids.some(id => typeof id !== 'string' || !id.startsWith(PREFIX)
            || !nativeId(id.slice(PREFIX.length)))) throw inputError();
        const features = [], absentIds = [];
        for (const id of new Set(ids)) {
            const native = id.slice(PREFIX.length);
            const bounds = parseToscanaLocator(await request({ service: 'WFS', version: '1.1.0', request: 'GetFeature',
                typename: LOCATOR, srsname: 'EPSG:4326', maxfeatures: 2, propertyname: 'pkuid',
                featureid: `${LOCATOR}.${native}` }, signal), native);
            if (!bounds) { absentIds.push(id); continue; }
            // No cached geometry, click context or configured sample locations: independently
            // locate every exact read, then enlarge the identify radius for holes/slender parcels.
            let found;
            for (const radius of [8, 32, 128, 256]) {
                const read = await gfi(bounds, radius, signal);
                found = read.features.find(row => row.id === id);
                if (found) break;
            }
            if (!found) throw invalid(); // A hit limit or failed locate is never authoritative absence.
            features.push(found);
        }
        return result(features, 'ids', { absentIds });
    }
    async function queryBounds(bounds, { signal } = {}) {
        validateBounds(bounds, 1);
        const scope = bboxPolygon(bounds), found = new Map(), pending = [{ bounds, depth: 0 }]; let requests = 0;
        while (pending.length) {
            if (++requests > 64) throw invalid();
            const current = pending.pop(), [w,s,e,n] = current.bounds;
            // RADIUS is in image pixels. The circumscribed identify window covers every
            // point in the requested rectangle; whole returned polygons are never clipped.
            const read = await gfi(current.bounds, Math.ceil(Math.hypot(PIXELS, PIXELS) / 2) + 2, signal);
            if (read.saturated) {
                if (current.depth >= 6) throw invalid();
                const x = (w+e)/2, y = (s+n)/2;
                for (const b of [[w,s,x,y],[x,s,e,y],[w,y,x,n],[x,y,e,n]]) pending.push({ bounds: b, depth: current.depth+1 });
                continue;
            }
            for (const row of read.features) if (booleanIntersects(row, scope)) {
                const old = found.get(row.id);
                if (old && JSON.stringify(old.geometry) !== JSON.stringify(row.geometry)) throw invalid();
                found.set(row.id, row);
            }
        }
        return result([...found.values()], 'bounds');
    }
    async function queryPoint(position, options) {
        if (!Array.isArray(position) || position.length !== 2 || !position.every(Number.isFinite)
            || Math.abs(position[0]) > 180 || Math.abs(position[1]) > 90) throw inputError();
        const [x,y] = position;
        const read = await queryBounds([x-0.000001,y-0.000001,x+0.000001,y+0.000001], options);
        return result(read.features.filter(row => booleanPointInPolygon(point(position), row)), 'point');
    }
    async function queryGeometry(geometry, options) {
        if (!validateGeometry(geometry)) throw inputError();
        const scope = { type: 'Feature', properties: {}, geometry }, read = await queryBounds(bbox(scope), options);
        return result(read.features.filter(row => booleanIntersects(row, scope)), 'geometry');
    }
    return Object.freeze({ queryIds, queryBounds, queryPoint, queryGeometry });
}
