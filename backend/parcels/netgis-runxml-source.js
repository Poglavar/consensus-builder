// Reads registered public municipal cadastral tables through the viewer's NetGIS RunXML protocol.
// Exact reads bypass caches; capped spatial responses are subdivided, never called complete.
import { SaxesParser } from 'saxes';
import proj4 from 'proj4';
import { bbox as geometryBbox, bboxPolygon, booleanIntersects, feature as geoFeature } from '@turf/turf';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';

export const NETGIS_SOURCE_ID = 'tr-ilkadim-belediyesi-netgis-kentrehberi-parsel';
export const NETGIS_ENDPOINT = 'https://keos.ilkadim.bel.tr/netgis7/ncwebgisservice.asmx/RunXML';
export const SANLIURFA_SOURCE_ID = 'tr-sanliurfa-buyuksehir-netgis-parcels';
export const SANLIURFA_ENDPOINT = 'https://keos.sanliurfa.bel.tr/Netgis7/ncwebgisservice.asmx/RunXML';
export const ANTAKYA_SOURCE_ID = 'tr-antakya-keos-kentrehberi-parsel';
export const ANTAKYA_ENDPOINT = 'https://keos.antakya.bel.tr/Keos/handlers/runXMLHandler.ashx';
const PROFILES = Object.freeze({
    [NETGIS_SOURCE_ID]: { endpoint: NETGIS_ENDPOINT, workspace: 'REHBER7', crs: 'EPSG:7934',
        projectionName: 'ITRF96 / TM36', prefix: 'TR-ILKADIM-KENTREHBERI-OBJECTID-' },
    [SANLIURFA_SOURCE_ID]: { endpoint: SANLIURFA_ENDPOINT, workspace: 'REHBER6', crs: 'EPSG:7935',
        projectionName: 'ITRF96 / TM39', prefix: 'TR-SANLIURFA-KENTREHBERI-OBJECTID-',
        viewer: 'https://keos.sanliurfa.bel.tr/keos/' },
    [ANTAKYA_SOURCE_ID]: { endpoint: ANTAKYA_ENDPOINT, workspace: 'REHBER6', crs: 'EPSG:7934',
        projectionName: 'ITRF96 / TM36', prefix: 'TR-ANTAKYA-KEOS-KENTREHBERI-OBJECTID-',
        viewer: 'https://keos.antakya.bel.tr/keos/', handler: true, rejectDuplicateIds: true }
});
const NATIVE = /^(?:0|[1-9][0-9]{0,14})$/;
const GML = 'http://www.opengis.net/gml';
const MAX_BYTES = 2 * 1024 * 1024;
const invalid = message => Object.assign(new Error(message), { status: 400, code: 'invalid-parcel-query' });
const bad = (reason = 'geometry structure') => upstreamError(`NetGIS returned unsupported cadastral XML (${reason}).`);

// No DTDs/entities, recovery, attribute inference, ring repair or geometry flattening.
function xmlTree(xml) {
    const parser = new SaxesParser({ xmlns: true });
    const stack = []; let root;
    parser.on('doctype', () => { throw bad(); });
    parser.on('opentag', tag => {
        if (stack.length > 40) throw bad();
        const node = { name: tag.local, uri: tag.uri, attributes: tag.attributes, children: [], text: '' };
        if (stack.length) stack.at(-1).children.push(node); else root = node;
        stack.push(node);
    });
    const addText = text => { if (stack.length) stack.at(-1).text += text; };
    parser.on('text', addText); parser.on('cdata', addText);
    parser.on('closetag', () => stack.pop());
    try { parser.write(xml).close(); } catch { throw bad('XML syntax'); }
    if (!root) throw bad('empty XML');
    return root;
}
const children = (node, name) => node.children.filter(child => child.name === name);
const attr = (node, name) => Object.values(node.attributes).find(a => a.local === name && !a.uri)?.value;
function one(node, name) {
    const found = children(node, name);
    if (found.length !== 1) throw bad(`expected one ${name}`);
    return found[0];
}
export function decodeNetgisXml(xml) {
    const outer = xmlTree(xml);
    return outer.name === 'string' && outer.uri === 'http://tempuri.org/' ? xmlTree(outer.text) : outer;
}
function nativeRing(boundary) {
    const coordinates = one(one(boundary, 'LinearRing'), 'coordinates');
    if (coordinates.uri !== GML || (attr(coordinates, 'cs') ?? ',') !== ','
        || (attr(coordinates, 'decimal') ?? '.') !== '.' || (attr(coordinates, 'ts') ?? ' ') !== ' ') throw bad();
    const ring = coordinates.text.trim().split(/\s+/).map(tuple => tuple.split(',').map(value => {
        if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) throw bad();
        const number = Number(value); if (!Number.isFinite(number)) throw bad(); return number;
    }));
    if (ring.length < 4 || ring.some(point => ![2, 3].includes(point.length) || point.length !== ring[0].length)
        || JSON.stringify(ring[0]) !== JSON.stringify(ring.at(-1))) throw bad();
    return ring;
}
export function parseNetgisParcels(xml, sourceCrs = 'EPSG:7934', { rejectDuplicateIds = false } = {}) {
    const root = decodeNetgisXml(xml);
    if (root.name !== 'FeatureCollection' || root.uri !== 'http://www.opengis.net/wfs') throw bad('feature collection');
    const rows = [], byId = new Map();
    const members = children(root, 'featureMember');
    for (const member of members) {
        if (member.uri !== GML || member.children.length !== 1) throw bad();
        const row = member.children[0];
        if (!row.name.endsWith('.kentrehberi_parsel')) throw bad('parcel table');
        const id = one(row, 'objectid').text.trim();
        if (!NATIVE.test(id)) throw bad('native ID format');
        const multi = one(one(row, 'GEOMETRY'), 'MultiGeometry');
        const polygons = multi.children.map(part => {
            if (part.name !== 'geometryMember') throw bad();
            const polygon = one(part, 'Polygon');
            if (polygon.uri !== GML || attr(polygon, 'srsName') !== sourceCrs
                || polygon.children.some(c => !['outerBoundaryIs', 'innerBoundaryIs'].includes(c.name))) throw bad();
            return [nativeRing(one(polygon, 'outerBoundaryIs')), ...children(polygon, 'innerBoundaryIs').map(nativeRing)];
        });
        if (!polygons.length) throw bad();
        const parcel = { id, geometry: polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0] }
            : { type: 'MultiPolygon', coordinates: polygons } };
        const previous = byId.get(id);
        if (previous && rejectDuplicateIds) throw bad(`duplicate native ID ${id}`);
        // Live exact reads of 30587 reproduce two byte-identical geometry rows.
        // Normalize only repeated representations of the SAME native entity.
        // Different IDs remain distinct even when their geometry is identical.
        if (previous && JSON.stringify(previous.geometry) !== JSON.stringify(parcel.geometry)) {
            throw bad(`conflicting geometry for native ID ${id}`);
        }
        if (!previous) { rows.push(parcel); byId.set(id, parcel); }
    }
    rows.responseRowCount = members.length;
    return rows;
}

async function readText(response) {
    if (!response.ok) { await response.body?.cancel(); throw providerHttpError(response); }
    const reader = response.body?.getReader();
    if (!reader) throw bad();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0, text = '';
    try {
        for (;;) {
            const { done, value } = await reader.read(); if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_BYTES) throw upstreamError('NetGIS parcel response exceeded its byte limit.');
            text += decoder.decode(value, { stream: true });
        }
        return text + decoder.decode();
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function idsFromCanonical(ids, prefix) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 80 || new Set(ids).size !== ids.length
        || ids.some(id => typeof id !== 'string' || !id.startsWith(prefix) || !NATIVE.test(id.slice(prefix.length)))) {
        throw invalid('Expected 1–80 distinct native NetGIS parcel IDs.');
    }
    return ids.map(id => id.slice(prefix.length));
}
export function createNetgisParcelSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    const profile = PROFILES[descriptor.id];
    if (!profile || descriptor.endpoint !== profile.endpoint
        || descriptor.adapter !== 'netgis-runxml' || descriptor.workspace !== profile.workspace
        || descriptor.layer !== 'kentrehberi_parsel' || descriptor.idField !== 'objectid'
        || descriptor.idPrefix !== profile.prefix || descriptor.outFields?.length !== 1 || descriptor.outFields[0] !== 'objectid'
        || descriptor.sourceCrs !== profile.crs || typeof descriptor.sourceProjection !== 'string'
        || !descriptor.sourceProjection.startsWith('PROJCS["' + profile.projectionName + '"')) throw new Error('Invalid municipal NetGIS descriptor.');
    const projection = proj4(descriptor.sourceProjection, 'EPSG:4326');
    const limit = Math.min(descriptor.pageSize ?? 200, 500);
    const maxFeatures = Math.min(descriptor.maxFeatures ?? 2000, 5000);
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(maxFeatures) || maxFeatures < 1) throw new Error('Invalid NetGIS limits.');
    const signalFor = signal => signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000);
    const result = (features, absentIds = []) => ({ type: 'FeatureCollection', sourceId: descriptor.id,
        features, absentIds, complete: true, returnsWGS84: true,
        coverage: { scope: 'bounded-municipal-table', citywideCompleteness: false } });
    function canonical(row) {
        const convert = values => typeof values[0] === 'number'
            ? [...projection.forward(values.slice(0, 2)), ...values.slice(2)] : values.map(convert);
        const geometry = { type: row.geometry.type, coordinates: convert(row.geometry.coordinates) };
        if (!validateGeometry(geometry)) throw bad();
        return canonicalParcelFeature(descriptor, { geometry, properties: { objectid: row.id } }, row.id);
    }
    // The public viewer issues an anonymous SessionId on every page load. This is
    // public bootstrap configuration, kept only in memory; no login/cookies used.
    let session;
    async function publicSession() {
        if (!profile.viewer) return '';
        if (!session) session = (async () => {
            // Shared bootstrap must survive cancellation of an obsolete viewport cell.
            const html = await readText(await fetchImpl(profile.viewer, { redirect: 'error', signal: AbortSignal.timeout(45000) }));
            const match = html.match(/_startupParameters=(\{[^\r\n]+?\})\s*;?\s*<\/script>/);
            let config;
            try { config = JSON.parse(match?.[1]); } catch { throw bad('public viewer configuration'); }
            if (config.Workspace !== descriptor.workspace || config.WebgisUrl !== new URL(descriptor.endpoint).origin + '/Netgis7'
                || !/^[a-f0-9]{32}$/.test(config.SessionId)) throw bad('public viewer binding');
            return config.SessionId;
        })().catch(error => { session = undefined; throw error; });
        return session;
    }
    async function request(filter, cap, signal) {
        // GETINFOEX has a fixed public cadastral schema. It ignores PropertyNames;
        // ask only for the safe fields and discard every other returned attribute.
        const data = '<GetInfoEx version="2.0"><GetInfo><LayerName>kentrehberi_parsel</LayerName>'
            + '<PropertyNames>objectid,GEOMETRY</PropertyNames><Filter><And>' + filter
            + '</And></Filter><MaxRecordCount>' + cap + '</MaxRecordCount></GetInfo></GetInfoEx>';
        const sessionId = await publicSession();
        // KEOS's public proxy has a different form contract from ASMX RunXML.
        // Its target is fixed by the municipal profile, never caller supplied.
        const form = profile.handler
            ? { webgisUrl: new URL(profile.endpoint).origin + '/Netgis7', workspaceName: descriptor.workspace,
                serviceName: 'CONMAN.GETINFOEX', sessionId, dataXML: data }
            : { WorkSpace: descriptor.workspace, ServiceName: 'CONMAN.GETINFOEX', SessionId: sessionId,
                DataXML: data, ServiceDependency: '' };
        const response = await fetchImpl(descriptor.endpoint, { method: 'POST', redirect: 'error', signal,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/xml' },
            body: new URLSearchParams(form).toString() });
        const rows = parseNetgisParcels(await readText(response), descriptor.sourceCrs, profile);
        if (rows.responseRowCount > cap) throw upstreamError('NetGIS exceeded the requested record cap.');
        return rows;
    }
    async function queryIds(ids, { signal } = {}) {
        const nativeIds = idsFromCanonical(ids, profile.prefix), features = [], absent = [], combined = signalFor(signal);
        for (const id of nativeIds) {
            const rows = await request('<PropertyIsEqualTo><PropertyName>objectid</PropertyName><Literal>' + id
                + '</Literal></PropertyIsEqualTo>', 200, combined);
            if (rows.responseRowCount >= 200) throw upstreamError('NetGIS exact query reached its cap; completeness is unknown.');
            if (rows.length > 1 || rows.some(row => row.id !== id)) throw upstreamError('NetGIS exact response did not match the requested ID.');
            if (!rows.length) absent.push(profile.prefix + id); else features.push(canonical(rows[0]));
        }
        return result(features, absent);
    }
    async function queryArea(geometry, bounds, { signal } = {}) {
        validateBounds(bounds, descriptor.maxBboxKm2 ?? 1);
        const combined = signalFor(signal), found = new Map(); let requests = 0;
        async function visit(box, depth = 0) {
            if (++requests > 64) throw upstreamError('NetGIS spatial subdivision exceeded its request budget.');
            const [w, s, e, n] = box;
            // Transform the actual query ring, preserving E,N wire order. The
            // provider's unrelated GETWORLD extent uses the opposite axis order.
            const ring = [[w,s],[e,s],[e,n],[w,n],[w,s]].map(point => [...projection.inverse(point), 0].join(',')).join(' ');
            const filter = '<Intersects><PropertyName>Geometry</PropertyName><gml:Polygon xmlns:gml="' + GML
                + '" srsName="' + descriptor.sourceCrs + '"><gml:outerBoundaryIs><gml:LinearRing><gml:coordinates decimal="." cs="," ts=" ">'
                + ring + '</gml:coordinates></gml:LinearRing></gml:outerBoundaryIs></gml:Polygon></Intersects>';
            const rows = await request(filter, limit, combined);
            if (rows.responseRowCount === limit) {
                if (depth >= 10) throw upstreamError('NetGIS spatial query still reaches its cap; completeness is unknown.');
                if (e - w > n - s) { const x = (w + e) / 2; await visit([w,s,x,n], depth + 1); await visit([x,s,e,n], depth + 1); }
                else { const y = (s + n) / 2; await visit([w,s,e,y], depth + 1); await visit([w,y,e,n], depth + 1); }
                return;
            }
            for (const row of rows) {
                const f = canonical(row), old = found.get(f.id);
                if (old && JSON.stringify(old.geometry) !== JSON.stringify(f.geometry)) throw upstreamError('NetGIS returned conflicting geometry for one native ID.');
                found.set(f.id, f);
                if (found.size > maxFeatures) throw upstreamError('NetGIS query exceeded its feature budget.');
            }
        }
        await visit(bounds);
        return result([...found.values()].filter(f => booleanIntersects(f, geoFeature(geometry))));
    }
    return { queryIds,
        async queryBounds(bounds, options) {
            validateBounds(bounds, descriptor.maxBboxKm2 ?? 1);
            return queryArea(bboxPolygon(bounds).geometry, bounds, options);
        },
        async queryGeometry(geometry, options) {
            if (!validateGeometry(geometry)) throw invalid('Expected a WGS84 parcel Polygon or MultiPolygon.');
            return queryArea(geometry, geometryBbox(geoFeature(geometry)), options);
        } };
}
