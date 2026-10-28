// SISGRAN cadastral reads use only native gid and whole GML geometry, with explicit server filters.
import { SaxesParser } from 'saxes';
import { bbox, bboxPolygon, booleanIntersects, booleanPointInPolygon, feature, point } from '@turf/turf';
import { concatBytes } from './byte-utils.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';

const SOURCE = 'br-cg-sisgran-infra-imoveis';
const ENDPOINT = 'https://sisgran.campogrande.ms.gov.br/sisgran/api/v1/maps/wms';
const LAYER = 'sisgran:vw_infra_imoveis', PREFIX = 'BR-CG-SISGRAN-';
const GML = 'http://www.opengis.net/gml', SIS = 'http://sisgran';
const EXTENT = [-54.78735572558, -21.48422056319851, -53.64679665912655, -20.23785052221368];
const MAX_BYTES = 8 * 1024 * 1024;
const invalid = () => upstreamError('SISGRAN returned invalid, conflicting or truncated parcel data.');
const inputError = () => Object.assign(new Error('Invalid SISGRAN parcel query.'), { status: 400 });
const nativeId = value => /^[1-9][0-9]{0,9}$/.test(value);

// Accept the observed GML2 namespace and wire axes; never infer identity from GeoServer FIDs.
export function parseSisgranGml(xml, descriptor, limit) {
    const parser = new SaxesParser({ xmlns: true });
    const stack = []; let root;
    parser.on('doctype', () => { throw invalid(); });
    parser.on('opentag', tag => {
        if (stack.length > 24) throw invalid();
        const node = { name: tag.local, uri: tag.uri, attrs: tag.attributes, children: [], text: '' };
        if (stack.length) stack.at(-1).children.push(node); else root = node;
        stack.push(node);
    });
    parser.on('text', text => { if (stack.length) stack.at(-1).text += text; });
    parser.on('closetag', () => stack.pop());
    parser.on('error', () => { throw invalid(); });
    try { parser.write(xml).close(); } catch { throw invalid(); }
    if (root?.name !== 'FeatureCollection' || root.uri !== 'http://www.opengis.net/wfs') throw invalid();
    const children = (node, uri, name) => node.children.filter(child => child.uri === uri && child.name === name);
    const one = (node, uri, name) => { const found = children(node, uri, name); if (found.length !== 1) throw invalid(); return found[0]; };
    const members = children(root, GML, 'featureMember');
    if (members.length >= limit || root.children.some(node => node.uri !== GML || !['boundedBy', 'featureMember'].includes(node.name))) throw invalid();
    const seen = new Set();
    return members.map(member => {
        const row = one(member, SIS, 'vw_infra_imoveis');
        if (member.children.length !== 1 || row.children.some(node => !(node.uri === SIS && ['gid', 'geom'].includes(node.name))
            && !(node.uri === GML && node.name === 'boundedBy'))) throw invalid();
        const gid = one(row, SIS, 'gid').text.trim();
        if (!nativeId(gid) || seen.has(gid)) throw invalid();
        seen.add(gid);
        const geom = one(row, SIS, 'geom'), multi = one(geom, GML, 'MultiPolygon');
        const crs = Object.values(multi.attrs).find(a => a.local === 'srsName')?.value;
        if (!['EPSG:4326', 'http://www.opengis.net/gml/srs/epsg.xml#4326'].includes(crs) || geom.children.length !== 1) throw invalid();
        const polygons = children(multi, GML, 'polygonMember');
        if (polygons.length !== multi.children.length) throw invalid();
        const coordinates = polygons.map(member => {
            const polygon = one(member, GML, 'Polygon');
            const boundaries = [one(polygon, GML, 'outerBoundaryIs'), ...children(polygon, GML, 'innerBoundaryIs')];
            if (polygon.children.length !== boundaries.length) throw invalid();
            return boundaries.map(boundary => {
                const ring = one(boundary, GML, 'LinearRing'), coord = one(ring, GML, 'coordinates');
                const attrs = Object.fromEntries(Object.values(coord.attrs).filter(a => !a.uri).map(a => [a.local, a.value]));
                if ((attrs.decimal ?? '.') !== '.' || (attrs.cs ?? ',') !== ',' || (attrs.ts ?? ' ') !== ' ') throw invalid();
                return coord.text.trim().split(/\s+/).map(pair => {
                    const values = pair.split(',');
                    if (values.length !== 2 || values.some(value => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value))) throw invalid();
                    return values.map(Number);
                });
            });
        });
        const geometry = { type: 'MultiPolygon', coordinates };
        if (!validateGeometry(geometry)) throw invalid();
        return canonicalParcelFeature(descriptor, { type: 'Feature', properties: { gid }, geometry }, gid);
    });
}

export function createSisgranWmsSource(descriptor, { fetchImpl = globalThis.fetch, timeoutMs = 30000,
    maxResponseBytes = MAX_BYTES } = {}) {
    if (descriptor?.id !== SOURCE || descriptor.adapter !== 'sisgran-wms' || descriptor.endpoint !== ENDPOINT
        || descriptor.layer !== LAYER || descriptor.idPrefix !== PREFIX || descriptor.idField !== 'gid'
        || descriptor.outFields?.length !== 1 || descriptor.outFields[0] !== 'gid'
        || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > MAX_BYTES
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 45000) throw new Error('Invalid SISGRAN descriptor.');
    const result = (features, queryType, extra = {}) => ({ type: 'FeatureCollection', sourceId: SOURCE,
        complete: true, returnsWGS84: true, features, queryType, ...extra });
    async function request(filter, bounds, limit, signal, pixels = 1024) {
        const url = new URL(ENDPOINT);
        url.search = new URLSearchParams({ SERVICE: 'WMS', VERSION: '1.3.0', REQUEST: 'GetFeatureInfo',
            LAYERS: LAYER, QUERY_LAYERS: LAYER, CRS: 'CRS:84', BBOX: bounds.join(','),
            WIDTH: String(pixels), HEIGHT: String(pixels), I: String(pixels / 2), J: String(pixels / 2),
            BUFFER: String(pixels), INFO_FORMAT: 'application/vnd.ogc.gml',
            FEATURE_COUNT: String(limit), PROPERTYNAME: 'gid,geom', CQL_FILTER: filter }).toString();
        const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
        try {
            const response = await fetchImpl(url.href, { method: 'GET', credentials: 'omit', redirect: 'error',
                headers: { Accept: 'application/vnd.ogc.gml' }, signal: combined });
            if (!response.ok) throw providerHttpError(response);
            if (Number(response.headers.get('content-length')) > maxResponseBytes) { await response.body?.cancel(); throw invalid(); }
            const reader = response.body?.getReader(); if (!reader) throw invalid();
            const chunks = []; let size = 0;
            try {
                for (;;) {
                    const { done, value } = await reader.read(); if (done) break;
                    size += value.byteLength;
                    if (size > maxResponseBytes) { await reader.cancel(); throw invalid(); }
                    chunks.push(value);
                }
            } finally { reader.releaseLock(); }
            return parseSisgranGml(new TextDecoder('utf-8', { fatal: true }).decode(concatBytes(chunks, size)), descriptor, limit);
        } catch (error) {
            if (signal?.aborted) throw signal.reason;
            if (combined.aborted) throw upstreamError('SISGRAN parcel provider timed out.', 504);
            if (error.status) throw error;
            throw upstreamError('SISGRAN parcel provider is unavailable.');
        }
    }
    async function queryIds(ids, { signal } = {}) {
        if (!Array.isArray(ids) || ids.length > 80 || ids.some(id => typeof id !== 'string' || !id.startsWith(PREFIX)
            || !nativeId(id.slice(PREFIX.length)))) throw inputError();
        const unique = [...new Set(ids)]; if (!unique.length) return result([], 'ids', { absentIds: [] });
        const filter = values => `gid IN (${values.map(id => id.slice(PREFIX.length)).join(',')})`;
        // GeoServer generalizes GFI geometry at the requested map scale. The broad
        // filtered read is ONLY a locator, never a cadastral geometry/cache result.
        // Independently locate on every call, then use deterministic small frames.
        const located = await request(filter(unique), EXTENT, unique.length + 1, signal, 4096);
        if (located.some(row => !unique.includes(row.id))) throw invalid();
        const groups = new Map();
        for (const row of located) {
            const [w, s, e, n] = bbox(feature(row.geometry));
            const x = Math.floor(((w + e) / 2) / 0.0025) * 0.0025;
            const y = Math.floor(((s + n) / 2) / 0.0025) * 0.0025;
            const bounds = [x - 0.00125, y - 0.00125, x + 0.00375, y + 0.00375].map(v => Number(v.toFixed(8)));
            const key = bounds.join(',');
            if (!groups.has(key)) groups.set(key, { bounds, ids: [] });
            groups.get(key).ids.push(row.id);
        }
        const rows = [];
        for (const { bounds, ids } of groups.values()) {
            const exact = await request(filter(ids), bounds, ids.length + 1, signal);
            if (exact.length !== ids.length || exact.some(row => !ids.includes(row.id))) throw invalid();
            rows.push(...exact);
        }
        const found = new Set(rows.map(row => row.id));
        return result(rows, 'ids', { absentIds: unique.filter(id => !found.has(id)) });
    }
    async function queryBounds(bounds, { signal } = {}) {
        validateBounds(bounds, 1);
        const located = await request(`BBOX(geom,${bounds.join(',')},'EPSG:4326')`, bounds, 501, signal);
        const rows = [];
        // Bounds and ID callers must see the same geometry, independent of viewport scale.
        for (let offset = 0; offset < located.length; offset += 80) {
            rows.push(...(await queryIds(located.slice(offset, offset + 80).map(row => row.id), { signal })).features);
        }
        const scope = bboxPolygon(bounds);
        return result(rows.filter(row => booleanIntersects(feature(row.geometry), scope)), 'bounds');
    }
    async function queryGeometry(geometry, options) {
        if (!validateGeometry(geometry)) throw inputError();
        const rows = await queryBounds(bbox(feature(geometry)), options);
        return result(rows.features.filter(row => booleanIntersects(feature(row.geometry), feature(geometry))), 'geometry');
    }
    async function queryPoint(position, options) {
        if (!Array.isArray(position) || position.length !== 2 || !position.every(Number.isFinite)) throw inputError();
        const [x, y] = position;
        const rows = await queryBounds([x - 0.000001, y - 0.000001, x + 0.000001, y + 0.000001], options);
        return result(rows.features.filter(row => booleanPointInPolygon(point(position), feature(row.geometry))), 'point');
    }
    return Object.freeze({ queryIds, queryBounds, queryGeometry, queryPoint });
}
