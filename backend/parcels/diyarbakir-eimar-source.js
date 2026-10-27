// DBB's public E-İmar service returns full boundaries by native OBJECTID or cadastral neighborhood.
// Its anonymous viewer nonce is session state, never a credential or saved input.
import { concatBytes } from './byte-utils.js';
import { bbox as geometryBbox, bboxPolygon, booleanIntersects, feature as geoFeature } from '@turf/turf';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';

export const DIYARBAKIR_SOURCE_ID = 'tr-diyarbakir-dbb-eimar-imarsvc-parcels';
export const DIYARBAKIR_ENDPOINT = 'https://cbs.diyarbakir.bel.tr/imardurumu/service/imarsvc.aspx';
const VIEWER = 'https://cbs.diyarbakir.bel.tr/imardurumu/';
const PREFIX = 'TR-DBB-';
const NATIVE_ID = /^[1-9][0-9]{0,15}$/;
const NONCE = /^[A-Za-z0-9_-]{1,256}$/;
const MAX_BYTES = 1024 * 1024;

function invalid(message) { return Object.assign(new Error(message), { status: 400, code: 'invalid-parcel-query' }); }
function areaUnsupported() {
    return upstreamError('DBB area lookup requires configured cadastral neighborhood search scopes.',
        422, 'parcel-source-area-unsupported');
}
const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
function checkDescriptor(d) {
    if (d?.id !== DIYARBAKIR_SOURCE_ID || d.adapter !== 'diyarbakir-eimar' || d.endpoint !== DIYARBAKIR_ENDPOINT
        || d.idPrefix !== PREFIX || d.idField !== 'OBJECTID' || d.outFields?.length !== 1 || d.outFields[0] !== 'OBJECTID'
        || typeof d.capabilities?.areaEnumeration !== 'boolean') throw new Error('Invalid DBB E-İmar parcel descriptor.');
    if (d.capabilities.areaEnumeration) {
        if (!Array.isArray(d.spatialScopes) || !d.spatialScopes.length || d.spatialScopes.length > 8
            || new Set(d.spatialScopes.map(scope => scope?.tapuMahalleId)).size !== d.spatialScopes.length
            || d.spatialScopes.some(scope => typeof scope?.tapuMahalleId !== 'string' || !NATIVE_ID.test(scope.tapuMahalleId)
                || typeof scope.name !== 'string' || !scope.name.trim())) throw new Error('Invalid DBB cadastral neighborhood scopes.');
        for (const scope of d.spatialScopes) validateBounds(scope.bbox, 2000);
    }
}
async function readJson(response, maxBytes = MAX_BYTES) {
    if (!response.ok) { await response.body?.cancel(); throw providerHttpError(response); }
    const reader = response.body?.getReader();
    if (!reader) throw upstreamError('DBB returned no readable parcel response.');
    const chunks = []; let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) throw upstreamError('DBB parcel response exceeded its byte limit.');
            chunks.push(value);
        }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(concatBytes(chunks, size))); }
    catch { throw upstreamError('DBB returned invalid parcel JSON.'); }
}
function parseIds(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 20 || new Set(ids).size !== ids.length
        || ids.some(id => typeof id !== 'string' || !id.startsWith(PREFIX) || !NATIVE_ID.test(id.slice(PREFIX.length)))) {
        throw invalid('Expected 1–20 distinct native DBB parcel IDs.');
    }
    return ids.map(id => id.slice(PREFIX.length));
}
function canonicalRow(d, row, expected) {
    const native = typeof row?.OBJECTID === 'number' && Number.isSafeInteger(row.OBJECTID) ? String(row.OBJECTID) : row?.OBJECTID;
    if (typeof native !== 'string' || !NATIVE_ID.test(native) || (expected && native !== expected)) {
        throw upstreamError('DBB exact response did not match its requested native parcel ID.');
    }
    let geometry;
    try { geometry = typeof row.POLY === 'string' ? JSON.parse(row.POLY) : row.POLY; }
    catch { throw upstreamError('DBB returned invalid parcel geometry JSON.'); }
    if (!validateGeometry(geometry)) throw upstreamError('DBB returned no usable WGS84 parcel polygon.');
    // ADAPARSEL, neighborhood names and any future provider fields are discarded.
    return canonicalParcelFeature(d, { geometry, properties: { OBJECTID: native } }, native);
}
export function createDiyarbakirParcelSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    checkDescriptor(descriptor);
    let session;
    const result = (features, absentIds = [], scope = 'exact-native-id') => ({ type: 'FeatureCollection', sourceId: descriptor.id,
        features, absentIds, complete: true, returnsWGS84: true,
        coverage: { scope, citywideCompleteness: false,
            ...(scope === 'configured-cadastral-neighborhoods' ? { neighborhoodIds: descriptor.spatialScopes.map(s => s.tapuMahalleId) } : {}) } });
    async function getSession(signal) {
        if (!session) session = (async () => {
            const response = await fetchImpl(VIEWER, { method: 'GET', redirect: 'error', signal });
            try {
                if (!response.ok) throw providerHttpError(response);
                let cookies = response.headers.getSetCookie?.();
                if (!cookies?.length) {
                    try { cookies = JSON.parse(response.headers.get('x-parcel-upstream-cookies') || '[]'); }
                    catch { throw upstreamError('DBB returned invalid anonymous session metadata.'); }
                }
                const nonce = cookies?.map(value => /^svc_nonce=([^;]*)/i.exec(value)?.[1]).find(Boolean);
                if (!NONCE.test(nonce || '')) throw upstreamError('DBB viewer did not issue its anonymous service nonce.');
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
            const url = new URL(DIYARBAKIR_ENDPOINT);
            url.search = new URLSearchParams(params);
            const response = await fetchImpl(url.href, { method: 'GET', redirect: 'error', signal,
                headers: { Accept: 'application/json', Referer: VIEWER, Cookie: `svc_nonce=${nonce}`, 'X-Service-Nonce': nonce } });
            if (response.status === 403 && attempt === 0) {
                await response.body?.cancel(); session = null; continue;
            }
            const rows = await readJson(response);
            if (!Array.isArray(rows)) throw upstreamError('DBB query did not return a parcel array.');
            return rows;
        }
    }
    async function queryIds(ids, { signal } = {}) {
        const natives = parseIds(ids), combined = querySignal(signal);
        const features = [], absentIds = [];
        for (const native of natives) {
            const rows = await requestRows({ type: 'parsel', parselid: native }, combined);
            if (!Array.isArray(rows) || rows.length > 1) throw upstreamError('DBB exact query did not return a singleton parcel result.');
            if (!rows.length) absentIds.push(PREFIX + native);
            else features.push(canonicalRow(descriptor, rows[0], native));
        }
        return result(features, absentIds);
    }
    async function queryArea(geometry, bounds, { signal } = {}) {
        if (!descriptor.capabilities.areaEnumeration) throw areaUnsupported();
        const combined = querySignal(signal), byId = new Map();
        // The public similar-text search matches the slash in every Ada/Parsel.
        // Always constrain it to a configured native cadastral neighborhood ID.
        // Municipal neighborhood polygons cannot locate cadastral neighborhoods:
        // current and cadastral boundaries differ even when their names match.
        for (const scope of descriptor.spatialScopes.filter(scope => overlaps(scope.bbox, bounds))) {
            const rows = await requestRows({ type: 'adaparsel', adaparsel: '/', tamKelimeAra: '1', tmahalle: scope.tapuMahalleId }, combined);
            if (rows.length > 5000) throw upstreamError('DBB cadastral neighborhood exceeded its feature limit.');
            for (const row of rows) {
                if (row.TAPU_MAH_ADI !== scope.name) throw upstreamError('DBB ignored its cadastral neighborhood filter.');
                const f = canonicalRow(descriptor, row);
                const old = byId.get(f.id);
                if (old && JSON.stringify(old.geometry) !== JSON.stringify(f.geometry)) throw upstreamError('DBB returned conflicting native parcel geometries.');
                byId.set(f.id, f);
            }
        }
        const query = geoFeature(geometry);
        const features = [...byId.values()].filter(f => booleanIntersects(query, f));
        if (features.length > (descriptor.maxFeatures ?? 2000)) throw upstreamError('DBB parcel query exceeded its feature limit.');
        return result(features, [], 'configured-cadastral-neighborhoods');
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

export function parseDiyarbakirOperation(body) {
    let data;
    try { data = JSON.parse(body); } catch { throw invalid('Invalid DBB relay operation.'); }
    if (!data || !['queryIds', 'queryBounds', 'queryGeometry'].includes(data._dbbOperation)
        || Object.keys(data).length !== 2 || !Object.hasOwn(data, 'input')) throw invalid('Invalid DBB relay operation.');
    return data;
}

export function createDiyarbakirBrowserSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    checkDescriptor(descriptor);
    const operation = method => async (input, { signal } = {}) => {
        if (method === 'queryIds') parseIds(input);
        if (method === 'queryBounds') validateBounds(input, descriptor.maxBboxKm2 ?? 25);
        if (method === 'queryGeometry') {
            if (!validateGeometry(input)) throw invalid('Expected a WGS84 parcel Polygon or MultiPolygon.');
            validateBounds(geometryBbox(geoFeature(input)), descriptor.maxBboxKm2 ?? 25);
        }
        if (method !== 'queryIds' && !descriptor.capabilities.areaEnumeration) throw areaUnsupported();
        const response = await fetchImpl(DIYARBAKIR_ENDPOINT, { method: 'POST', redirect: 'error', signal,
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ _dbbOperation: method, input }) });
        const data = await readJson(response, 2 * MAX_BYTES);
        if (data?.type !== 'FeatureCollection' || data.sourceId !== descriptor.id || data.complete !== true
            || data.returnsWGS84 !== true || !Array.isArray(data.features) || data.features.length > (descriptor.maxFeatures ?? 2000)
            || !Array.isArray(data.absentIds)) throw upstreamError('DBB relay returned an invalid parcel collection.');
        const features = data.features.map(f => {
            const native = f?.properties?.sourceParcelId;
            if (typeof native !== 'string' || !NATIVE_ID.test(native) || f.id !== PREFIX + native
                || f.properties.sourceId !== descriptor.id || !validateGeometry(f.geometry)) throw upstreamError('DBB relay returned an invalid parcel.');
            return canonicalParcelFeature(descriptor, { geometry: f.geometry, properties: { OBJECTID: native } }, native);
        });
        const found = features.map(f => f.id), absent = data.absentIds;
        if (method === 'queryIds' && (new Set([...found, ...absent]).size !== input.length
            || [...found, ...absent].some(id => !input.includes(id)) || found.length + absent.length !== input.length)) {
            throw upstreamError('DBB relay did not account for the requested exact IDs.');
        }
        return { ...data, features };
    };
    return Object.fromEntries(['queryIds', 'queryBounds', 'queryGeometry'].map(method => [method, operation(method)]));
}
