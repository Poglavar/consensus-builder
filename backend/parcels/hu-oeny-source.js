// Budapest cadastral outlines: bounded Lechner HRSZ enumeration followed by OÉNY
// search and exact-ID reads. Native outlines are only reprojected for map transport.
import proj4 from 'proj4';
import { bbox, booleanIntersects, booleanPointInPolygon, feature, point } from '@turf/turf';
import { concatBytes } from './byte-utils.js';
import { createSourceRequestQueue } from './source-request-pacing.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';

export const OENY_SOURCE_ID = 'hu-lechner-oeny-cadastral-parcels';
export const OENY_ENDPOINT = 'https://www.oeny.hu/hk-api/parcels/at';
export const HRSZ_ENDPOINT = 'https://api.lechnerkozpont.hu/hrsz-terminator/api/hrsz';
export const EOV_DEFINITION = '+proj=somerc +lat_0=47.1443937222222 +lon_0=19.0485717777778 +k_0=0.99993 +x_0=650000 +y_0=200000 +ellps=GRS67 +towgs84=52.17,-71.82,-14.9,0,0,0,0 +units=m +no_defs';
const PREFIX = 'HU-OENY-HRSZ-';
const API = 'https://www.oeny.hu/hk-api/parcels/';
const ID = /^[1-9][0-9]{0,14}$/;
const LOT = /^[0-9]+(?:\/[0-9A-Za-z]+)*$/;
const sharedRequestQueue = createSourceRequestQueue();
const invalid = () => upstreamError('OÉNY returned inconsistent or malformed cadastral parcel data.');
const badInput = message => Object.assign(new Error(message), { status: 400, code: 'invalid-parcel-query' });
export const wgs84ToEov = coordinates => proj4('EPSG:4326', EOV_DEFINITION, coordinates);
export const eovToWgs84 = coordinates => proj4(EOV_DEFINITION, 'EPSG:4326', coordinates);

export function createOenyParcelSource(descriptor, { fetchImpl = globalThis.fetch, timeoutMs = 20000,
    maxResponseBytes = 1024 * 1024, queueRequestImpl = sharedRequestQueue, now = Date.now } = {}) {
    if (descriptor?.id !== OENY_SOURCE_ID || descriptor.adapter !== 'hu-oeny'
        || descriptor.endpoint !== OENY_ENDPOINT || descriptor.idPrefix !== PREFIX
        || descriptor.idField !== 'id' || descriptor.outFields?.length !== 1 || descriptor.outFields[0] !== 'id'
        || descriptor.capabilities?.areaEnumeration !== true || typeof fetchImpl !== 'function'
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000
        || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 2 * 1024 * 1024
        || typeof queueRequestImpl !== 'function' || typeof now !== 'function') {
        throw new Error('Invalid OÉNY cadastral parcel descriptor.');
    }
    const result = (features, queryType, extra = {}) => ({ type: 'FeatureCollection', features,
        complete: true, sourceId: descriptor.id, returnsWGS84: true, queryType, ...extra });
    const budget = () => ({ bytes: 0, requests: 0, signal: AbortSignal.timeout(120000) });
    // Adjacent viewport cells share a lot; reuse only their in-session successful
    // joins briefly. Explicit exact-ID reads always bypass this cache.
    const viewportLots = new Map();

    async function request(endpoint, params, scope) {
        if (++scope.requests > 180) throw upstreamError('OÉNY query exceeds its request budget.');
        const url = new URL(endpoint);
        url.search = new URLSearchParams(params).toString();
        const signal = AbortSignal.any([scope.signal, AbortSignal.timeout(timeoutMs)]);
        let response;
        try {
            response = await queueRequestImpl(OENY_SOURCE_ID, 1100, () => {
                signal.throwIfAborted();
                return fetchImpl(url.href, { method: 'GET', redirect: 'error', credentials: 'omit',
                    headers: { Accept: 'application/json' }, signal });
            });
            if (!response.ok) { await response.body?.cancel(); throw providerHttpError(response); }
            const reader = response.body?.getReader();
            if (!reader) throw invalid();
            const chunks = [];
            let bytes = 0;
            try {
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    bytes += value.byteLength;
                    scope.bytes += value.byteLength;
                    if (bytes > maxResponseBytes || scope.bytes > 16 * 1024 * 1024) {
                        await reader.cancel();
                        throw upstreamError('OÉNY query exceeds its streamed byte budget.');
                    }
                    chunks.push(value);
                }
            } finally { reader.releaseLock(); }
            try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(concatBytes(chunks, bytes))); }
            catch { throw invalid(); }
        } catch (error) {
            if (signal.aborted) throw upstreamError('OÉNY cadastral lookup timed out.', 504);
            if (error.status) throw error;
            throw upstreamError('OÉNY cadastral lookup is unavailable.');
        }
    }

    async function search(kshCode, lotNumber, scope) {
        if (!/^(?:budap|[0-9]{5})$/.test(kshCode) || !LOT.test(lotNumber)) throw invalid();
        const rows = await request(`${API}search`, { kshCode, lotNumber }, scope);
        if (!Array.isArray(rows) || rows.length > 500) throw invalid();
        const exact = rows.filter(row => row.lotNumber === lotNumber);
        if (exact.length !== 1 || !Number.isSafeInteger(exact[0].id) || !ID.test(String(exact[0].id))) throw invalid();
        return String(exact[0].id);
    }

    function parcel(payload, nativeId) {
        // Project immediately to the geometry and native ID. Incidental provider
        // attributes, including addresses, are never returned, logged or retained.
        if (!payload || payload.settlement?.name !== 'Budapest' || typeof payload.lotNumber !== 'string'
            || !LOT.test(payload.lotNumber) || !/^[0-9]{5}$/.test(payload.settlement.kshCode)) throw invalid();
        const native = payload.outline;
        if (!native || !['Polygon', 'MultiPolygon'].includes(native.type)) throw invalid();
        let vertices = 0;
        const ring = coordinates => {
            if (!Array.isArray(coordinates) || coordinates.length < 4) throw invalid();
            const converted = coordinates.map(p => {
                if (!Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite)
                    || p[0] < 400000 || p[0] > 950000 || p[1] < 0 || p[1] > 400000 || ++vertices > 100000) throw invalid();
                return eovToWgs84(p);
            });
            return converted;
        };
        let geometry;
        try {
            geometry = { type: native.type, coordinates: native.type === 'Polygon'
                ? native.coordinates.map(ring) : native.coordinates.map(p => p.map(ring)) };
        } catch { throw invalid(); }
        if (!validateGeometry(geometry)) throw invalid();
        return canonicalParcelFeature(descriptor, { type: 'Feature', geometry, properties: { id: nativeId } }, nativeId);
    }

    async function exact(nativeId, scope, expectedLot = null) {
        const payload = await request(`${API}bounding-box`, { id: nativeId }, scope);
        const f = parcel(payload, nativeId);
        if (expectedLot !== null && payload.lotNumber !== expectedLot) throw invalid();
        // This route does not echo its numeric ID. Verify the reverse mapping;
        // old discovery IDs were reassigned when the provider refreshed its data.
        if (expectedLot === null && await search(payload.settlement.kshCode, payload.lotNumber, scope) !== nativeId) throw invalid();
        return f;
    }

    async function queryIds(ids) {
        if (!Array.isArray(ids) || ids.length > 80 || ids.some(id => typeof id !== 'string'
            || !id.startsWith(PREFIX) || !ID.test(id.slice(PREFIX.length)))) throw badInput('Expected up to 80 canonical OÉNY numeric parcel IDs.');
        const scope = budget(), features = [];
        for (const id of new Set(ids)) features.push(await exact(id.slice(PREFIX.length), scope));
        // No explicit-absence response has been established; HTTP and schema
        // failures remain errors rather than being cached as absent parcels.
        return result(features, 'ids', { absentIds: [] });
    }

    async function queryPoint(coordinates) {
        if (!Array.isArray(coordinates) || coordinates.length !== 2 || !coordinates.every(Number.isFinite)
            || Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90) throw badInput('Expected WGS84 [longitude, latitude].');
        const scope = budget();
        const [x, y] = wgs84ToEov(coordinates);
        const payload = await request(OENY_ENDPOINT, { x, y }, scope);
        const nativeId = await search(payload?.settlement?.kshCode, payload?.lotNumber, scope);
        const f = parcel(payload, nativeId);
        if (!booleanPointInPolygon(point(coordinates), f)) throw invalid();
        return result([f], 'point', { point: [...coordinates] });
    }

    async function queryBounds(bounds) {
        validateBounds(bounds, 0.9);
        const [w, s, e, n] = bounds;
        // Densify only the request perimeter to bound the nonlinear projection.
        // Returned parcel rings are never clipped, simplified, repaired or rounded.
        const ring = [];
        const corners = [[w, s], [e, s], [e, n], [w, n], [w, s]];
        for (let edge = 0; edge < 4; edge++) for (let j = 0; j < 8; j++) {
            const a = corners[edge], b = corners[edge + 1];
            ring.push(wgs84ToEov(a.map((v, axis) => v + (b[axis] - v) * j / 8)));
        }
        ring.push([...ring[0]]);
        const scope = budget();
        const payload = await request(HRSZ_ENDPOINT, { geojson: JSON.stringify({ type: 'Polygon', coordinates: [ring] }) }, scope);
        if (payload?.success !== true || !Array.isArray(payload.data)) throw invalid();
        if (payload.data.length >= 500 || payload.data.length > (descriptor.maxFeatures || 80)) {
            throw upstreamError('HRSZ parcel count reaches the bounded query limit; request smaller cells.', 422, 'parcel-source-area-too-dense');
        }
        const features = new Map();
        const lots = new Map();
        for (const row of payload.data) {
            if (typeof row.ksh_telepules !== 'string' || !/^BUDAPEST(?:\s|$)/i.test(row.ksh_telepules)
                || typeof row.hrsz !== 'string' || !LOT.test(row.hrsz)) throw invalid();
            const context = JSON.stringify([row.ksh_telepules, row.fekves]);
            if (lots.has(row.hrsz)) {
                if (lots.get(row.hrsz) !== context) throw invalid();
                continue;
            }
            lots.set(row.hrsz, context);
            // The official viewer uses its synthetic 'budap' settlement code to
            // search all capital districts; the exact response retains the KSH code.
            let cached = viewportLots.get(row.hrsz);
            if (cached && cached.context !== context) throw invalid();
            if (!cached || cached.expires <= now()) {
                const promise = (async () => {
                    const id = await search('budap', row.hrsz, scope);
                    return exact(id, scope, row.hrsz);
                })();
                cached = { promise, context, expires: now() + 60000 };
                viewportLots.set(row.hrsz, cached);
                promise.catch(() => { if (viewportLots.get(row.hrsz) === cached) viewportLots.delete(row.hrsz); });
                while (viewportLots.size > 160) viewportLots.delete(viewportLots.keys().next().value);
            }
            const f = await cached.promise;
            features.set(f.id, f);
        }
        return result([...features.values()], 'bounds', { bbox: [...bounds],
            completeness: { mode: 'bounded-hrsz-intersections', areaCompleteness: 'provider-list-only',
                enumeratedLots: lots.size, limit: 500, citywide: false } });
    }

    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw badInput('Expected a WGS84 polygon.');
        const read = await queryBounds(bbox(feature(geometry)));
        return { ...read, queryType: 'geometry', features: read.features.filter(f => booleanIntersects(f, feature(geometry))) };
    }
    return Object.freeze({ queryIds, queryPoint, queryBounds, queryGeometry });
}
