// Saltillo's public municipal predio rings and native idCarto locator; no parcel-detail requests.
import { bbox, bboxPolygon, booleanIntersects, booleanPointInPolygon, feature, point } from '@turf/turf';
import { concatBytes } from './byte-utils.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';

export const SALTILLO_SOURCE_ID = 'mx-saltillo-visor-urban-predios';
export const SALTILLO_ENDPOINT = 'https://visor.saltillo.gob.mx/buscar_php_puro_utm.php';
export const SALTILLO_LOCATOR = 'https://visor.saltillo.gob.mx/buscar_por_texto.php';
const PREFIX = 'MX-SALTILLO-VISOR|idCarto|';
const MAX_BYTES = 16 * 1024 * 1024;
const nativeId = value => (typeof value === 'string' || Number.isSafeInteger(value))
    && /^[1-9]\d{0,11}$/.test(String(value)) ? String(value) : null;
const inputError = message => Object.assign(new Error(message), { status: 400 });
const fail = message => { throw upstreamError(`Saltillo: ${message}`); };
const validPoint = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)
    && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;

// Shared with the relay: the only search input is a native numeric ID, never text or personal data.
export function isSaltilloParcelRequest(url, method, body) {
    if (!(url instanceof URL) || url.username || url.password || url.hash) return false;
    if (url.origin + url.pathname === SALTILLO_LOCATOR) {
        return method === 'GET' && body == null && [...url.searchParams.keys()].length === 1
            && url.searchParams.getAll('q').length === 1 && !!nativeId(url.searchParams.get('q'));
    }
    if (url.href !== SALTILLO_ENDPOINT || method !== 'POST' || typeof body !== 'string') return false;
    const p = new URLSearchParams(body);
    if ([...p.keys()].length !== 2 || p.getAll('lat').length !== 1 || p.getAll('lng').length !== 1
        || ['lat', 'lng'].some(key => !/^-?\d+(?:\.\d+)?$/.test(p.get(key)))) return false;
    return validPoint([Number(p.get('lng')), Number(p.get('lat'))]);
}

async function readJson(response, cap) {
    if (!response.ok) throw providerHttpError(response);
    const reader = response.body?.getReader();
    if (!reader) fail('missing response stream.');
    let size = 0;
    const chunks = [];
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > cap) { await reader.cancel(); fail('response exceeded its byte budget.'); }
            chunks.push(value);
        }
    } finally { reader.releaseLock(); }
    let payload;
    try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(concatBytes(chunks, size))); }
    catch { fail('invalid JSON response.'); }
    return { payload, bytes: size };
}

function parseNeighborhood(descriptor, rows) {
    if (!Array.isArray(rows) || rows.length > 15000) fail('invalid or oversized neighborhood array.');
    const found = new Map();
    const unusableIds = new Set();
    const ambiguousIds = new Set();
    let unidentifiedRecords = 0;
    for (const row of rows) {
        // The official viewer also renders unnamed objects, but cannot open a predio for them.
        // They are not given invented identities or silently promoted to cadastral parcels.
        if (row?.idCarto == null || row.idCarto === '' || row.idCarto === 'null') { unidentifiedRecords++; continue; }
        const id = nativeId(row.idCarto);
        if (!id) fail('identified predio lacks a usable native ID.');
        if (!Array.isArray(row.coords)) { unusableIds.add(id); continue; }
        const coordinates = row.coords.map(p => [p?.lng, p?.lat]);
        const geometry = { type: 'Polygon', coordinates: [coordinates] };
        // Do not close or repair provider rings. A defective neighbor cannot stand in for a
        // requested exact ID, but need not hide all the usable parcels in a viewport either.
        if (!validateGeometry(geometry)) { unusableIds.add(id); continue; }
        const previous = found.get(id);
        if (previous && JSON.stringify(previous.geometry) !== JSON.stringify(geometry)) { ambiguousIds.add(id); continue; }
        found.set(id, canonicalParcelFeature(descriptor, { type: 'Feature', geometry, properties: { idCarto: id } }, id));
    }
    for (const id of unusableIds) found.delete(id);
    for (const id of ambiguousIds) found.delete(id);
    return { found, unusableIds, ambiguousIds, unidentifiedRecords, responseRecords: rows.length };
}

export function createSaltilloVisorSource(descriptor, { fetchImpl = globalThis.fetch, timeoutMs = 30000,
    maxResponseBytes = descriptor?.maxResponseBytes ?? MAX_BYTES } = {}) {
    if (descriptor?.id !== SALTILLO_SOURCE_ID || descriptor.adapter !== 'saltillo-visor'
        || descriptor.endpoint !== SALTILLO_ENDPOINT || descriptor.locatorEndpoint !== SALTILLO_LOCATOR
        || descriptor.idPrefix !== PREFIX || descriptor.idField !== 'idCarto' || descriptor.parcelNumberField !== 'idCarto'
        || descriptor.outFields?.length !== 1 || descriptor.outFields[0] !== 'idCarto'
        || typeof fetchImpl !== 'function' || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024
        || maxResponseBytes > MAX_BYTES || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 45000) {
        throw new Error('Invalid Saltillo Visor source descriptor.');
    }
    const neighborhoods = new Map();
    const result = (features, queryType, extra = {}) => ({ type: 'FeatureCollection', sourceId: descriptor.id,
        features, complete: true, returnsWGS84: true, queryType,
        // A finished anonymous response is not a municipal cadastral completeness guarantee.
        areaCompleteness: 'unverified', ...extra });

    async function request(url, options, cap, signal) {
        const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
        return readJson(await fetchImpl(url, { ...options, credentials: 'omit', redirect: 'error', signal: combined }), cap);
    }

    async function neighborhood(center, signal) {
        if (!validPoint(center)) throw inputError('Expected a WGS84 [longitude, latitude] point.');
        const { payload, bytes } = await request(SALTILLO_ENDPOINT, { method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ lat: String(center[1]), lng: String(center[0]) }).toString()
        }, maxResponseBytes, signal);
        return { ...parseNeighborhood(descriptor, payload), streamedBytes: bytes };
    }

    async function queryIds(ids, { signal } = {}) {
        if (!Array.isArray(ids) || ids.length > 80 || ids.some(id => typeof id !== 'string'
            || !id.startsWith(PREFIX) || !nativeId(id.slice(PREFIX.length)))) throw inputError('Invalid Saltillo canonical parcel IDs.');
        const wanted = [...new Set(ids)];
        const features = new Map();
        const absentIds = [];
        let streamedBytes = 0;
        const budget = signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000);
        // Each invocation starts fresh. A neighborhood may answer several nearby requested IDs,
        // but no prior viewport/sample geometry can satisfy an independent exact-ID read.
        for (const id of wanted) {
            if (features.has(id)) continue;
            const native = id.slice(PREFIX.length);
            const url = new URL(SALTILLO_LOCATOR);
            url.searchParams.set('q', native);
            const located = await request(url.href, { headers: { Accept: 'application/json' } }, 16384, budget);
            streamedBytes += located.bytes;
            if (located.payload === null) { absentIds.push(id); continue; }
            if (!located.payload || nativeId(located.payload.idCarto) !== native
                || !validPoint([located.payload.lng, located.payload.lat])) fail('ID locator did not match the requested idCarto.');
            if (streamedBytes + maxResponseBytes > 64 * 1024 * 1024) fail('exact-ID batch exceeds its byte budget.');
            const read = await neighborhood([located.payload.lng, located.payload.lat], budget);
            streamedBytes += read.streamedBytes;
            if (read.ambiguousIds.has(native)) fail('located idCarto has conflicting source rings.');
            if (read.unusableIds.has(native)) fail('located idCarto has unusable polygon coordinates.');
            if (!read.found.has(native)) fail('located idCarto was missing from its live neighborhood.');
            for (const requested of wanted) {
                const requestedNative = requested.slice(PREFIX.length);
                if (read.ambiguousIds.has(requestedNative)) fail('requested idCarto has conflicting source rings.');
                if (read.unusableIds.has(requestedNative)) fail('requested idCarto has unusable polygon coordinates.');
                const found = read.found.get(requestedNative);
                if (!found) continue;
                const previous = features.get(requested);
                if (previous && JSON.stringify(previous.geometry) !== JSON.stringify(found.geometry)) fail('exact-ID neighborhoods disagree.');
                features.set(requested, found);
            }
        }
        return result([...features.values()], 'ids', { absentIds, streamedBytes });
    }

    async function queryBounds(bounds, { signal } = {}) {
        // Small app grid cells fit well inside observed neighborhoods. The undocumented server
        // radius and truncation behavior remain a second-pass completeness follow-up.
        validateBounds(bounds, 0.05, { maxBboxWidthM: 200, maxBboxHeightM: 200 });
        // The public route returns thousands of nearby rings per click. Adjacent app cells
        // share a fixed map-point request, not a cached claim of all-city coverage. These
        // 0.004-degree blocks are smaller than the observed neighborhood at the queue point.
        // Query centers change; source vertices never do. Exact-ID reads bypass this cache.
        const center = [0, 1].map(i => Number((Math.floor(((bounds[i] + bounds[i + 2]) / 2) / 0.004) * 0.004 + 0.002).toFixed(8)));
        const key = center.join(',');
        let cached = neighborhoods.get(key);
        if (!cached || cached.expires <= Date.now()) {
            if (neighborhoods.size >= 8) neighborhoods.delete(neighborhoods.keys().next().value);
            // Individual cell cancellation must not abort a neighborhood shared by another cell.
            cached = { promise: neighborhood(center), expires: Date.now() + 30000 };
            neighborhoods.set(key, cached);
            cached.promise.catch(() => { if (neighborhoods.get(key) === cached) neighborhoods.delete(key); });
        }
        signal?.throwIfAborted();
        const read = await cached.promise;
        signal?.throwIfAborted();
        const target = bboxPolygon(bounds);
        const features = [...read.found.values()].filter(f => booleanIntersects(f, target));
        return result(features, 'bounds', { bbox: [...bounds], searchCenter: center, streamedBytes: read.streamedBytes,
            unidentifiedRecords: read.unidentifiedRecords, responseRecords: read.responseRecords,
            unusableRecordCount: read.unusableIds.size, unusableIds: [...read.unusableIds].slice(0, 20).map(id => PREFIX + id),
            ambiguousRecordCount: read.ambiguousIds.size, ambiguousIds: [...read.ambiguousIds].slice(0, 20).map(id => PREFIX + id) });
    }

    async function queryPoint(coordinates, options = {}) {
        const read = await neighborhood(coordinates, options.signal);
        return result([...read.found.values()].filter(f => booleanPointInPolygon(point(coordinates), f)), 'point',
            { point: [...coordinates], streamedBytes: read.streamedBytes });
    }

    async function queryGeometry(geometry, options = {}) {
        if (!validateGeometry(geometry)) throw inputError('Expected a WGS84 parcel query polygon.');
        const target = feature(geometry);
        const read = await queryBounds(bbox(target), options);
        return { ...read, queryType: 'geometry', features: read.features.filter(f => booleanIntersects(f, target)) };
    }
    return { queryIds, queryBounds, queryPoint, queryGeometry };
}
