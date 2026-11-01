// NRSC Bhuvan TG_Cad: native GeoServer fids and unchanged, geometry-only GML2.
// A fixed inline style supplies a whole-frame identify tolerance without labels.
// Large frames are locators only: every result is freshly refined at a source vertex.
import { SaxesParser } from 'saxes';
import { bbox, bboxPolygon, booleanIntersects, booleanPointInPolygon, feature, point } from '@turf/turf';
import { concatBytes } from './byte-utils.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';

export const BHUVAN_SOURCE = 'in-nrsc-bhuvan-telangana-tg-cad-gfi';
export const BHUVAN_ENDPOINT = 'https://bhuvan-vec1.nrsc.gov.in/bhuvan/ows';
const SOURCE = BHUVAN_SOURCE, ENDPOINT = BHUVAN_ENDPOINT;
const LAYER = 'cadastral:TG_Cad', PREFIX = 'IN-NRSC-TG-';
const GML = 'http://www.opengis.net/gml', CAD = 'http://bhuvan-vec1.nrsc.gov.in/cadastral';
const EXTENT = [77.23560954500005, 15.836347645000046, 81.20527479500002, 19.91799289400007];
const MAX_BYTES = 2 * 1024 * 1024, LIMIT = 501;
const invalid = () => upstreamError('Bhuvan returned invalid, conflicting or truncated cadastral geometry.');
const inputError = () => upstreamError('Invalid Bhuvan parcel query.', 400, 'invalid-parcel-query');
const nativeId = value => typeof value === 'string' && /^TG_Cad\.[1-9][0-9]{0,9}$/.test(value);
// Public WMS UserStyle; no external resource, labels, credentials or remote feature layer.
// GeoServer's automatic stroke tolerance spans the map frame. Explicit BUFFER is ignored
// by this publisher. GetStyles documents cad_2d_new's 1:10,000 visibility cutoff.
export const BHUVAN_AREA_STYLE = '<StyledLayerDescriptor version="1.0.0" xmlns="http://www.opengis.net/sld"><NamedLayer><Name>cadastral:TG_Cad</Name><UserStyle><FeatureTypeStyle><Rule><PolygonSymbolizer><Fill><CssParameter name="fill">#808080</CssParameter></Fill><Stroke><CssParameter name="stroke">#808080</CssParameter><CssParameter name="stroke-width">2000</CssParameter></Stroke></PolygonSymbolizer></Rule></FeatureTypeStyle></UserStyle></NamedLayer></StyledLayerDescriptor>';

export function parseBhuvanGml(xml, descriptor, limit) {
    const parser = new SaxesParser({ xmlns: true });
    const stack = []; let root, nodes = 0;
    parser.on('doctype', () => { throw invalid(); });
    parser.on('opentag', tag => {
        if (++nodes > 100000 || stack.length > 24) throw invalid();
        const crs = Object.values(tag.attributes).find(a => !a.uri && a.local === 'srsName')?.value;
        if (tag.uri === GML && crs !== undefined
            && !['EPSG:4326', 'http://www.opengis.net/gml/srs/epsg.xml#4326'].includes(crs)) throw invalid();
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
        const row = one(member, CAD, 'TG_Cad');
        if (member.children.length !== 1 || row.children.some(node => !(node.uri === CAD && node.name === 'the_geom')
            && !(node.uri === GML && node.name === 'boundedBy'))) throw invalid();
        const gid = Object.values(row.attrs).find(a => !a.uri && a.local === 'fid')?.value;
        if (!nativeId(gid) || seen.has(gid)) throw invalid();
        seen.add(gid);
        const geom = one(row, CAD, 'the_geom'), multi = one(geom, GML, 'MultiPolygon');
        const crs = Object.values(multi.attrs).find(a => a.local === 'srsName')?.value;
        if (!['EPSG:4326', 'http://www.opengis.net/gml/srs/epsg.xml#4326'].includes(crs) || geom.children.length !== 1) throw invalid();
        const polygons = children(multi, GML, 'polygonMember');
        if (polygons.length !== multi.children.length) throw invalid();
        const coordinates = polygons.map(member => {
            const polygon = one(member, GML, 'Polygon');
            if (member.children.length !== 1) throw invalid();
            const boundaries = [one(polygon, GML, 'outerBoundaryIs'), ...children(polygon, GML, 'innerBoundaryIs')];
            if (polygon.children.length !== boundaries.length) throw invalid();
            return boundaries.map(boundary => {
                const ring = one(boundary, GML, 'LinearRing'), coord = one(ring, GML, 'coordinates');
                if (boundary.children.length !== 1 || ring.children.length !== 1 || coord.children.length) throw invalid();
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
        return canonicalParcelFeature(descriptor, { type: 'Feature', properties: { fid: gid }, geometry }, gid);
    });
}

export function createBhuvanTgCadSource(descriptor, { fetchImpl = globalThis.fetch, timeoutMs = 30000,
    maxResponseBytes = MAX_BYTES } = {}) {
    if (descriptor?.id !== SOURCE || descriptor.adapter !== 'bhuvan-tg-cad' || descriptor.endpoint !== ENDPOINT
        || descriptor.layer !== LAYER || descriptor.style !== 'cad_2d_new' || descriptor.idPrefix !== PREFIX
        || descriptor.idField !== 'fid' || descriptor.outFields?.length !== 1 || descriptor.outFields[0] !== 'fid'
        || !Array.isArray(descriptor.lookupBounds) || descriptor.lookupBounds.length !== 4
        || descriptor.lookupBounds.some((v, i) => !Number.isFinite(v) || (i < 2 ? v < EXTENT[i] : v > EXTENT[i]))
        || descriptor.lookupBounds[0] >= descriptor.lookupBounds[2] || descriptor.lookupBounds[1] >= descriptor.lookupBounds[3]
        || descriptor.lookupBounds[2] - descriptor.lookupBounds[0] > 0.5 || descriptor.lookupBounds[3] - descriptor.lookupBounds[1] > 0.5
        || typeof fetchImpl !== 'function' || !Number.isSafeInteger(maxResponseBytes)
        || maxResponseBytes < 1024 || maxResponseBytes > MAX_BYTES
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 45000) throw new Error('Invalid Bhuvan TG_Cad descriptor.');
    const result = (features, queryType, extra = {}) => ({ type: 'FeatureCollection', sourceId: SOURCE,
        complete: true, returnsWGS84: true, features, queryType, ...extra });
    async function request(bounds, limit, filter, signal, exact = false) {
        const url = new URL(ENDPOINT);
        url.search = new URLSearchParams({ service: 'WMS', version: '1.1.1', request: 'GetFeatureInfo',
            layers: LAYER, query_layers: LAYER, styles: exact ? 'cad_2d_new' : '',
            ...(!exact ? { SLD_BODY: BHUVAN_AREA_STYLE } : {}), srs: 'EPSG:4326', bbox: bounds.join(','),
            width: '1000', height: '1000', x: '500', y: '500', info_format: 'application/vnd.ogc.gml',
            feature_count: String(limit), propertyName: 'the_geom', ...filter }).toString();
        const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
        try {
            combined.throwIfAborted();
            const response = await fetchImpl(url.href, { method: 'GET', credentials: 'omit', redirect: 'error',
                headers: { Accept: 'application/vnd.ogc.gml' }, signal: combined });
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
            return parseBhuvanGml(new TextDecoder('utf-8', { fatal: true }).decode(concatBytes(chunks, size)), descriptor, limit);
        } catch (error) {
            if (signal?.aborted) throw signal.reason;
            if (combined.aborted) throw upstreamError('Bhuvan parcel provider timed out.', 504);
            if (error.status) throw error;
            throw upstreamError('Bhuvan parcel provider is unavailable.');
        }
    }
    async function refine(row, signal) {
        // Douglas-Peucker keeps the starting source vertex, even when a broad locator
        // collapses a small polygon. It is a locator, never returned/cached parcel geometry.
        const vertex = row.geometry.coordinates[0][0][0];
        const bounds = [vertex[0] - 0.00005, vertex[1] - 0.00005, vertex[0] + 0.00005, vertex[1] + 0.00005];
        const rows = await request(bounds, 2, { featureid: row.properties.sourceParcelId }, signal, true);
        if (rows.length !== 1 || rows[0].id !== row.id) throw invalid();
        return rows[0];
    }
    async function queryIds(ids, { signal } = {}) {
        if (!Array.isArray(ids) || ids.length > 80 || ids.some(id => typeof id !== 'string' || !id.startsWith(PREFIX)
            || !nativeId(id.slice(PREFIX.length)))) throw inputError();
        const unique = [...new Set(ids)], rows = [], absentIds = [];
        for (const id of unique) {
            // The native-fid filter bounds this city routing-window read to one parcel.
            // Fresh independent lookup on every call; no saved locator or polygon dependency.
            const located = await request(descriptor.lookupBounds, 2, { featureid: id.slice(PREFIX.length) }, signal);
            if (located.some(row => row.id !== id)) throw invalid();
            // A city window cannot prove a native fid absent from the state service.
            if (!located.length) throw upstreamError('Bhuvan native fid was not located within the configured city window.', 422, 'parcel-id-not-located');
            else rows.push(await refine(located[0], signal));
        }
        return result(rows, 'ids', { absentIds });
    }
    async function queryBounds(bounds, { signal } = {}) {
        validateBounds(bounds, 2);
        if (bounds[0] < descriptor.lookupBounds[0] || bounds[1] < descriptor.lookupBounds[1]
            || bounds[2] > descriptor.lookupBounds[2] || bounds[3] > descriptor.lookupBounds[3]) throw inputError();
        const located = await request(bounds, LIMIT, { cql_filter: `BBOX(the_geom,${bounds.join(',')},'EPSG:4326')` }, signal);
        const rows = [];
        for (const row of located) rows.push(await refine(row, signal));
        const scope = bboxPolygon(bounds);
        return result(rows.filter(row => booleanIntersects(row, scope)), 'bounds');
    }
    async function queryGeometry(geometry, options) {
        if (!validateGeometry(geometry)) throw inputError();
        const rows = await queryBounds(bbox(feature(geometry)), options);
        return result(rows.features.filter(row => booleanIntersects(row, feature(geometry))), 'geometry');
    }
    async function queryPoint(position, options) {
        if (!Array.isArray(position) || position.length !== 2 || !position.every(Number.isFinite)
            || Math.abs(position[0]) > 180 || Math.abs(position[1]) > 90) throw inputError();
        const [x, y] = position;
        const rows = await queryBounds([x - 0.000001, y - 0.000001, x + 0.000001, y + 0.000001], options);
        return result(rows.features.filter(row => booleanPointInPolygon(point(position), row)), 'point');
    }
    // Serialize provider reads even when callers invoke separate operations concurrently.
    let pending = Promise.resolve();
    const serial = operation => (...args) => {
        const task = pending.then(() => operation(...args));
        pending = task.catch(() => {}); return task;
    };
    return Object.freeze(Object.fromEntries(Object.entries({ queryIds, queryBounds, queryGeometry, queryPoint })
        .map(([method, operation]) => [method, serial(operation)])));
}
