// Pinned municipal public Netcad E-İmar services return unchanged cadastral polygons by OBJECTID.
// Viewport lookup searches configured cadastral blocks live; it never implies citywide coverage.
// Its anonymous viewer nonce is session state, never a credential or saved input.
import { concatBytes } from './byte-utils.js';
import { bbox as geometryBbox, bboxPolygon, booleanIntersects, feature as geoFeature } from '@turf/turf';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';

export const MERSIN_SOURCE_ID = 'tr-mersin-yenisehir-keos-imar-parcels';
export const MERSIN_ENDPOINT = 'https://keos.yenisehir.bel.tr/imardurumu/service/imarsvc.aspx';
const MERSIN_VIEWER = 'https://keos.yenisehir.bel.tr/imardurumu/index.aspx';
const MERSIN_PREFIX = 'tr-mersin-yenisehir-keos-imar-parcels:OBJECTID=';
export const VAN_SOURCE_ID = 'tr-ipekyolu-belediyesi-eimar-kentrehberi-parsel';
export const VAN_ENDPOINT = 'https://keos.ipekyolu.bel.tr:90/imardurumu/service/imarsvc.aspx';
export const SIVAS_SOURCE_ID = 'tr-sivas-belediyesi-eimar-parsel';
export const SIVAS_ENDPOINT = 'https://keos.sivas.bel.tr/imardurumu/service/imarsvc.aspx';
const PROFILES = [
    { id: MERSIN_SOURCE_ID, endpoint: MERSIN_ENDPOINT, viewer: MERSIN_VIEWER, prefix: MERSIN_PREFIX },
    { id: VAN_SOURCE_ID, endpoint: VAN_ENDPOINT,
        viewer: 'https://keos.ipekyolu.bel.tr:90/imardurumu/index.aspx', prefix: VAN_SOURCE_ID + ':OBJECTID=' },
    { id: SIVAS_SOURCE_ID, endpoint: SIVAS_ENDPOINT,
        viewer: 'https://keos.sivas.bel.tr/imardurumu/', prefix: SIVAS_SOURCE_ID + ':OBJECTID=' }
];
export function isMersinProtocolSource(d) {
    return d?.adapter === 'mersin-eimar' && PROFILES.some(p => p.id === d.id && p.endpoint === d.endpoint);
}
const NATIVE_ID = /^[1-9][0-9]{0,15}$/;
const NONCE = /^[A-Za-z0-9_-]{1,256}$/;
const MAX_BYTES = 1024 * 1024;

function invalid(message) { return Object.assign(new Error(message), { status: 400, code: 'invalid-parcel-query' }); }
function areaUnsupported() {
    return upstreamError('Municipal E-İmar area lookup requires configured cadastral block search scopes.',
        422, 'parcel-source-area-unsupported');
}
const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
function checkDescriptor(d) {
    const profile = PROFILES.find(p => p.id === d?.id && p.endpoint === d.endpoint);
    if (!profile || d.adapter !== 'mersin-eimar'
        || d.idPrefix !== profile.prefix || d.idField !== 'OBJECTID' || d.outFields?.length !== 1 || d.outFields[0] !== 'OBJECTID'
        || typeof d.capabilities?.areaEnumeration !== 'boolean') throw new Error('Invalid municipal E-İmar parcel descriptor.');
    if (!d.capabilities.areaEnumeration || !Array.isArray(d.spatialScopes) || !d.spatialScopes.length
        || d.spatialScopes.length > 8 || new Set(d.spatialScopes.map(scope => scope?.block)).size !== d.spatialScopes.length
        || d.spatialScopes.some(scope => typeof scope?.block !== 'string' || !NATIVE_ID.test(scope.block))) {
        throw new Error('Invalid municipal E-İmar cadastral block scopes.');
    }
    for (const scope of d.spatialScopes) validateBounds(scope.bbox, 25);
    return profile;
}
async function readJson(response, maxBytes = MAX_BYTES) {
    if (!response.ok) { await response.body?.cancel(); throw providerHttpError(response); }
    const reader = response.body?.getReader();
    if (!reader) throw upstreamError('Municipal E-İmar returned no readable parcel response.');
    const chunks = []; let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) throw upstreamError('Municipal E-İmar parcel response exceeded its byte limit.');
            chunks.push(value);
        }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(concatBytes(chunks, size))); }
    catch { throw upstreamError('Municipal E-İmar returned invalid parcel JSON.'); }
}
function parseIds(ids, PREFIX) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 80 || new Set(ids).size !== ids.length
        || ids.some(id => typeof id !== 'string' || !id.startsWith(PREFIX) || !NATIVE_ID.test(id.slice(PREFIX.length)))) {
        throw invalid('Expected 1–80 distinct native municipal E-İmar parcel IDs.');
    }
    return ids.map(id => id.slice(PREFIX.length));
}
function canonicalRow(d, row, expected) {
    const native = typeof row?.OBJECTID === 'number' && Number.isSafeInteger(row.OBJECTID) ? String(row.OBJECTID) : row?.OBJECTID;
    if (typeof native !== 'string' || !NATIVE_ID.test(native) || (expected && native !== expected)) {
        throw upstreamError('Municipal E-İmar exact response did not match its requested native parcel ID.');
    }
    let geometry;
    try { geometry = typeof row.POLY === 'string' ? JSON.parse(row.POLY) : row.POLY; }
    catch { throw upstreamError('Municipal E-İmar returned invalid parcel geometry JSON.'); }
    if (!validateGeometry(geometry)) throw upstreamError('Municipal E-İmar returned no usable WGS84 parcel polygon.');
    // ADAPARSEL, neighborhood names and any future provider fields are discarded.
    return canonicalParcelFeature(d, { geometry, properties: { OBJECTID: native } }, native);
}
export function createMersinParcelSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    const { endpoint: ENDPOINT, viewer: VIEWER, prefix: PREFIX } = checkDescriptor(descriptor);
    let session;
    const result = (features, absentIds = [], scope = 'exact-native-id') => ({ type: 'FeatureCollection', sourceId: descriptor.id,
        features, absentIds, complete: true, returnsWGS84: true,
        coverage: { scope, citywideCompleteness: false,
            ...(scope === 'configured-cadastral-blocks' ? { blocks: descriptor.spatialScopes.map(s => s.block) } : {}) } });
    async function getSession(signal) {
        if (!session) session = (async () => {
            const response = await fetchImpl(VIEWER, { method: 'GET', redirect: 'error', signal });
            try {
                if (!response.ok) throw providerHttpError(response);
                let cookies = response.headers.getSetCookie?.();
                if (!cookies?.length) {
                    try { cookies = JSON.parse(response.headers.get('x-parcel-upstream-cookies') || '[]'); }
                    catch { throw upstreamError('Municipal E-İmar returned invalid anonymous session metadata.'); }
                }
                const nonce = cookies?.map(value => /^svc_nonce=([^;]*)/i.exec(value)?.[1]).find(Boolean);
                if (!NONCE.test(nonce || '')) throw upstreamError('Municipal E-İmar viewer did not issue its anonymous service nonce.');
                return nonce;
            } finally { await response.body?.cancel(); }
        })().catch(error => { session = null; throw error; });
        return session;
    }
    function querySignal(signal) {
        const budgetSignal = AbortSignal.timeout(60000);
        return signal ? AbortSignal.any([budgetSignal, signal]) : budgetSignal;
    }
    async function requestRows(params, signal) {
        for (let attempt = 0; attempt < 2; attempt++) {
            const nonce = await getSession(signal);
            const url = new URL(ENDPOINT);
            url.search = new URLSearchParams(params);
            const response = await fetchImpl(url.href, { method: 'GET', redirect: 'error', signal,
                headers: { Accept: 'application/json', Referer: VIEWER, Cookie: `svc_nonce=${nonce}`, 'X-Service-Nonce': nonce } });
            if (response.status === 403 && attempt === 0) {
                await response.body?.cancel(); session = null; continue;
            }
            const rows = await readJson(response);
            if (!Array.isArray(rows)) throw upstreamError('Municipal E-İmar query did not return a parcel array.');
            return rows;
        }
    }
    async function queryIds(ids, { signal } = {}) {
        const natives = parseIds(ids, PREFIX), combined = querySignal(signal);
        const features = [], absentIds = [];
        for (const native of natives) {
            const rows = await requestRows({ type: 'parsel', parselid: native }, combined);
            if (!Array.isArray(rows) || rows.length > 1) throw upstreamError('Municipal E-İmar exact query did not return a singleton parcel result.');
            if (!rows.length) absentIds.push(PREFIX + native);
            else features.push(canonicalRow(descriptor, rows[0], native));
        }
        return result(features, absentIds);
    }
    async function queryArea(geometry, bounds, { signal } = {}) {
        if (!descriptor.capabilities.areaEnumeration) throw areaUnsupported();
        const combined = querySignal(signal), byId = new Map();
        // This is the viewer's public similar-text Ada/Parsel search, bounded to a
        // verified cadastral block. Never use a citywide wildcard or a saved sample.
        for (const scope of descriptor.spatialScopes.filter(scope => overlaps(scope.bbox, bounds))) {
            const rows = await requestRows({ type: 'adaparsel', adaparsel: scope.block + '/', tamKelimeAra: '1' }, combined);
            // Conservatively reject responses reaching the family transfer guard;
            // a smaller response does not prove provider-wide completeness.
            if (rows.length >= 1000) throw upstreamError('Municipal E-İmar block search reached the transfer cap guard.');
            for (const row of rows) {
                // Similar-text search may also match another block's suffix. Check
                // the safe cadastral search key in memory and discard it afterward.
                if (typeof row.ADAPARSEL !== 'string' || !/^[0-9]+\/[0-9]+$/.test(row.ADAPARSEL)) {
                    throw upstreamError('Municipal E-İmar returned an invalid cadastral search key.');
                }
                if (row.ADAPARSEL.split('/')[0] !== scope.block) continue;
                const f = canonicalRow(descriptor, row);
                const old = byId.get(f.id);
                if (old && JSON.stringify(old.geometry) !== JSON.stringify(f.geometry)) throw upstreamError('Municipal E-İmar returned conflicting native parcel geometries.');
                byId.set(f.id, f);
            }
        }
        const query = geoFeature(geometry);
        const features = [...byId.values()].filter(f => booleanIntersects(query, f));
        if (features.length > (descriptor.maxFeatures ?? 2000)) throw upstreamError('Municipal E-İmar parcel query exceeded its feature limit.');
        return result(features, [], 'configured-cadastral-blocks');
    }
    return {
        queryIds,
        async queryBounds(bounds, options) {
            validateBounds(bounds, descriptor.maxBboxKm2 ?? 25);
            return queryArea(bboxPolygon(bounds).geometry, bounds, options);
        },
        async queryGeometry(geometry, options) {
            if (!validateGeometry(geometry)) throw invalid('Expected a WGS84 parcel Polygon or MultiPolygon.');
            const bounds = geometryBbox(geoFeature(geometry));
            validateBounds(bounds, descriptor.maxBboxKm2 ?? 25);
            return queryArea(geometry, bounds, options);
        }
    };
}

export function parseMersinOperation(body) {
    let data;
    try { data = JSON.parse(body); } catch { throw invalid('Invalid Municipal E-İmar relay operation.'); }
    if (!data || !['queryIds', 'queryBounds', 'queryGeometry'].includes(data._mersinOperation)
        || Object.keys(data).length !== 2 || !Object.hasOwn(data, 'input')) throw invalid('Invalid Municipal E-İmar relay operation.');
    return data;
}

export function createMersinBrowserSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    const { endpoint: ENDPOINT, prefix: PREFIX } = checkDescriptor(descriptor);
    const operation = method => async (input, { signal } = {}) => {
        if (method === 'queryIds') parseIds(input, PREFIX);
        if (method === 'queryBounds') validateBounds(input, descriptor.maxBboxKm2 ?? 25);
        if (method === 'queryGeometry') {
            if (!validateGeometry(input)) throw invalid('Expected a WGS84 parcel Polygon or MultiPolygon.');
            validateBounds(geometryBbox(geoFeature(input)), descriptor.maxBboxKm2 ?? 25);
        }
        if (method !== 'queryIds' && !descriptor.capabilities.areaEnumeration) throw areaUnsupported();
        const response = await fetchImpl(ENDPOINT, { method: 'POST', redirect: 'error', signal,
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ _mersinOperation: method, input }) });
        const data = await readJson(response, 2 * MAX_BYTES);
        if (data?.type !== 'FeatureCollection' || data.sourceId !== descriptor.id || data.complete !== true
            || data.returnsWGS84 !== true || !Array.isArray(data.features) || data.features.length > (descriptor.maxFeatures ?? 2000)
            || !Array.isArray(data.absentIds)) throw upstreamError('Municipal E-İmar relay returned an invalid parcel collection.');
        const features = data.features.map(f => {
            const native = f?.properties?.sourceParcelId;
            if (typeof native !== 'string' || !NATIVE_ID.test(native) || f.id !== PREFIX + native
                || f.properties.sourceId !== descriptor.id || !validateGeometry(f.geometry)) throw upstreamError('Municipal E-İmar relay returned an invalid parcel.');
            return canonicalParcelFeature(descriptor, { geometry: f.geometry, properties: { OBJECTID: native } }, native);
        });
        const found = features.map(f => f.id), absent = data.absentIds;
        if (method === 'queryIds' && (new Set([...found, ...absent]).size !== input.length
            || [...found, ...absent].some(id => !input.includes(id)) || found.length + absent.length !== input.length)) {
            throw upstreamError('Municipal E-İmar relay did not account for the requested exact IDs.');
        }
        return { ...data, features };
    };
    return Object.fromEntries(['queryIds', 'queryBounds', 'queryGeometry'].map(method => [method, operation(method)]));
}
