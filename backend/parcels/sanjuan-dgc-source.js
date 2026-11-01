// DGC's public vector route: unchanged parcel geometry and native Feature.id only.
import { bbox, bboxPolygon, booleanIntersects, feature } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { concatBytes } from './byte-utils.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';

export const SANJUAN_SOURCE = 'ar-sanjuan-dgc-public-parcel-vector';
export const SANJUAN_ENDPOINT = 'https://servicioscatastro.sanjuan.gob.ar/DgcConsultasWeb/KusaServer/ClassDataPortal/910003/6';
export const SANJUAN_REQUEST_TIMEOUT_MS = 45000;
const PREFIX = 'AR-SJ-DGC-PARCEL-';
const nativeId = value => /^(0|[1-9]\d{0,14})$/.test(value) && Number.isSafeInteger(Number(value));
// Only scope comparisons tolerate floating point grid-edge roundoff; source coordinates do not change.
const contains = (a, b) => a[0] <= b[0] + 1e-12 && a[1] <= b[1] + 1e-12
    && a[2] + 1e-12 >= b[2] && a[3] + 1e-12 >= b[3];

export function isSanJuanSource(d) {
    return d?.id === SANJUAN_SOURCE && d.adapter === 'sanjuan-dgc' && d.endpoint === SANJUAN_ENDPOINT;
}

// The relay must never expose the adjacent ClassDataPortal edit or personal-record operations.
export function isSanJuanRequest(d, url, method = 'GET', body) {
    if (!isSanJuanSource(d) || method !== 'GET' || body !== undefined
        || url.origin + url.pathname !== SANJUAN_ENDPOINT || url.hash || url.username || url.password
        || [...url.searchParams.keys()].length !== 1 || url.searchParams.getAll('bbox').length !== 1) return false;
    const text = url.searchParams.get('bbox');
    if (!/^-?\d+(?:\.\d+)?(?:,-?\d+(?:\.\d+)?){3}$/.test(text)) return false;
    try {
        const box = validateBounds(text.split(',').map(Number), d.maxBboxKm2 ?? 6);
        return d.lookupBounds?.some(scope => contains(scope, box)) === true;
    } catch { return false; }
}

export function createSanJuanDgcSource(d, { fetchImpl = globalThis.fetch, onRead } = {}) {
    const maxBytes = d.maxResponseBytes ?? 8 * 1024 * 1024;
    if (!isSanJuanSource(d) || d.idPrefix !== PREFIX || d.idField !== 'id'
        || d.outFields?.length !== 1 || d.outFields[0] !== 'id'
        || !Array.isArray(d.lookupBounds) || !d.lookupBounds.length || d.lookupBounds.length > 8
        || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 16 * 1024 * 1024
        || typeof fetchImpl !== 'function') throw new Error('Invalid San Juan DGC parcel descriptor.');
    const scopes = d.lookupBounds.map(box => [...validateBounds(box, d.maxBboxKm2 ?? 6)]);
    const diagnostics = { requests: 0, streamedBytes: 0, emptyGeometryCount: 0, operationTimeoutRetries: 0 };
    const result = (features, extra = {}) => ({ type: 'FeatureCollection', sourceId: d.id,
        returnsWGS84: true, features, complete: true, areaComplete: false, authoritativeAbsence: false,
        coverageScope: 'bounded-lookup-windows',
        completenessReason: 'Complete bounded response transfer; no provider total/paging or citywide completeness proof.', ...extra });

    async function readBounds(bounds, signal, budget = { bytes: 0 }) {
        validateBounds(bounds, d.maxBboxKm2 ?? 6);
        if (!scopes.some(scope => contains(scope, bounds))) {
            throw new HttpError(400, 'Bounds exceed the configured San Juan DGC lookup scope.');
        }
        const url = new URL(SANJUAN_ENDPOINT);
        url.searchParams.set('bbox', bounds.join(','));
        let response;
        for (let attempt = 0; attempt < 2; attempt++) {
            signal?.throwIfAborted();
            const timeout = AbortSignal.timeout(SANJUAN_REQUEST_TIMEOUT_MS);
            response = await fetchImpl(url.href, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
                redirect: 'error', credentials: 'omit', headers: { Accept: 'application/json' } });
            diagnostics.requests++;
            if (response.ok) break;
            await response.body?.cancel();
            // The public DGC sometimes returns a SQL operation timeout after ~31 s,
            // then recovers on the next read. Retry this idempotent, bounded GET once;
            // access denials, rate limits, cancellation and persistent failures stay errors.
            if (response.status !== 500 || attempt === 1) throw providerHttpError(response);
            diagnostics.operationTimeoutRetries++;
            onRead?.({ bbox: bounds, httpStatus: response.status, retry: true });
        }
        const reader = response.body?.getReader();
        if (!reader) throw upstreamError('DGC returned no response body.');
        let size = 0;
        const chunks = [];
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                diagnostics.streamedBytes += value.byteLength;
                budget.bytes += value.byteLength;
                if (size > maxBytes || budget.bytes > 64 * 1024 * 1024) {
                    throw upstreamError('DGC parcel response exceeds the streaming byte budget.');
                }
                chunks.push(value);
            }
        } catch (error) {
            await reader.cancel().catch(() => {});
            throw error;
        } finally { reader.releaseLock(); }
        let data;
        try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(concatBytes(chunks, size))); }
        catch { throw upstreamError('DGC returned malformed JSON.'); }
        if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features) || data.features.length > 10000
            || data.error || data.exceededTransferLimit === true || data.complete === false) {
            throw upstreamError('DGC returned an incomplete or unusable parcel collection.');
        }
        const found = new Map();
        let emptyGeometryCount = 0;
        for (const row of data.features) {
            if (row?.type !== 'Feature' || !['string', 'number'].includes(typeof row.id)
                || !nativeId(String(row.id))) throw upstreamError('DGC returned an invalid native parcel ID.');
            if (row.geometry == null || (row.geometry?.type === 'Polygon' && Array.isArray(row.geometry.coordinates)
                && row.geometry.coordinates.every(ring => Array.isArray(ring) && ring.length === 0))) {
                emptyGeometryCount++;
                continue;
            }
            if (!validateGeometry(row.geometry)) throw upstreamError('DGC returned unusable polygon coordinates.');
            const id = String(row.id);
            const clean = canonicalParcelFeature(d, { geometry: row.geometry, properties: { id } }, id);
            const previous = found.get(id);
            if (previous && JSON.stringify(previous.geometry) !== JSON.stringify(clean.geometry)) {
                throw upstreamError('DGC returned conflicting geometry for one native parcel ID.');
            }
            found.set(id, clean);
        }
        diagnostics.emptyGeometryCount += emptyGeometryCount;
        onRead?.({ bbox: bounds, httpStatus: response.status, streamedBytes: size,
            returnedCount: data.features.length, usableCount: found.size, emptyGeometryCount });
        return result([...found.values()], { emptyGeometryCount, streamedBytes: size });
    }

    async function queryIds(ids, { signal } = {}) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80 || ids.some(id => typeof id !== 'string'
            || !id.startsWith(PREFIX) || !nativeId(id.slice(PREFIX.length)))) {
            throw new HttpError(400, 'Provide between 1 and 80 canonical DGC parcel IDs.');
        }
        const wanted = [...new Set(ids)], found = new Map(), budget = { bytes: 0 };
        // No geometry cache or retained sample is used for exact reads, including after restart.
        // The public viewer exposes bbox reads, not a documented native-ID geometry operation.
        for (const scope of scopes) {
            const rows = await readBounds(scope, signal, budget);
            for (const row of rows.features) if (wanted.includes(row.id)) {
                const previous = found.get(row.id);
                if (previous && JSON.stringify(previous.geometry) !== JSON.stringify(row.geometry)) {
                    throw upstreamError('DGC returned conflicting geometry across lookup windows.');
                }
                found.set(row.id, row);
            }
        }
        return result([...found.values()], { complete: wanted.every(id => found.has(id)), absentIds: [],
            completenessReason: 'Requested native IDs found by fresh bounded scans; unobserved IDs remain unresolved.' });
    }
    async function queryGeometry(geometry, options) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide a WGS84 polygon.');
        const rows = await readBounds(bbox(feature(geometry)), options?.signal);
        return { ...rows, features: rows.features.filter(row => booleanIntersects(row, feature(geometry))) };
    }
    async function queryBounds(bounds, { signal } = {}) {
        const rows = await readBounds(bounds, signal);
        return { ...rows, features: rows.features.filter(row => booleanIntersects(row, bboxPolygon(bounds))) };
    }
    return Object.freeze({ queryBounds, queryIds, queryGeometry, getDiagnostics: () => ({ ...diagnostics }) });
}
