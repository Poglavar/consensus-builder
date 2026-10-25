// Anonymous UgNLIS cadastral selector enumeration and fresh native-ID reads.
// Only IDs and geometry leave the adapter; registration details are discarded.
import proj4 from 'proj4';
import { bbox as geometryBbox, booleanIntersects, feature as turfFeature } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { concatBytes } from './byte-utils.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';

export const UGN_SOURCE_ENDPOINT = 'https://api.mlhud.go.ug/ugnlis-data-api/v1/nalisep-api-data/query-parcelle/query-parcelle/parcel-search';
export const UGN_FILTER_ENDPOINT = `${UGN_SOURCE_ENDPOINT}filter`;
// EPSG:21096 plus EPSG's Arc 1960 to WGS 84 (1), applicable in Uganda (35 m accuracy).
// This is a published datum operation, with no fitted displacement or geometry rounding.
export const UGN_NATIVE_PROJECTION = '+proj=utm +zone=36 +a=6378249.145 +rf=293.465 +towgs84=-160,-6,-302 +units=m +no_defs';
const projection = proj4(UGN_NATIVE_PROJECTION, 'EPSG:4326');
const NATIVE_ID = /^(?:[0-9]{1,20}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const MAX_BYTES = 2 * 1024 * 1024;

function projectGeometry(geometry) {
    if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) throw upstreamError('UgNLIS returned a non-polygon boundary.');
    const walk = (coordinates, depth) => {
        if (!Array.isArray(coordinates) || !coordinates.length) throw upstreamError('UgNLIS returned malformed coordinates.');
        if (depth > 0) return coordinates.map(value => walk(value, depth - 1));
        if (coordinates.length < 2 || !coordinates.every(Number.isFinite)) throw upstreamError('UgNLIS returned malformed coordinates.');
        return [...projection.forward(coordinates.slice(0, 2)), ...coordinates.slice(2)];
    };
    const result = { type: geometry.type, coordinates: walk(geometry.coordinates, geometry.type === 'Polygon' ? 2 : 3) };
    if (!validateGeometry(result)) throw upstreamError('UgNLIS returned an unusable polygon boundary.');
    return result;
}

async function readJson(response) {
    if (!response.ok) throw providerHttpError(response);
    const declared = response.headers?.get('content-length');
    if (declared !== null && Number(declared) > MAX_BYTES) throw upstreamError('UgNLIS response exceeds the byte limit.');
    const reader = response.body?.getReader();
    if (!reader) throw upstreamError('UgNLIS returned no response body.');
    const chunks = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BYTES) throw upstreamError('UgNLIS response exceeds the byte limit.');
            chunks.push(value);
        }
    } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
    } finally { reader.releaseLock(); }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(concatBytes(chunks, size))); }
    catch { throw upstreamError('UgNLIS returned an empty or invalid JSON response.'); }
}

async function mapLimited(items, concurrency, operation) {
    const output = new Array(items.length);
    let next = 0;
    let failed = false;
    const workers = await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (!failed && next < items.length) {
            const index = next++;
            try { output[index] = await operation(items[index]); }
            catch (error) { failed = true; throw error; }
        }
    }));
    const rejection = workers.find(result => result.status === 'rejected');
    if (rejection) throw rejection.reason;
    return output;
}

export function createUgnlisParcelSource(descriptor, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    const { id, idPrefix, selector } = descriptor || {};
    const maxFeatures = descriptor?.maxFeatures ?? 500;
    const timeoutMs = descriptor?.timeoutMs ?? 30000;
    const concurrency = descriptor?.enumerationConcurrency ?? 6;
    if (descriptor?.adapter !== 'ugnlis-parcel-search' || descriptor.endpoint !== UGN_SOURCE_ENDPOINT
        || descriptor.filterEndpoint !== UGN_FILTER_ENDPOINT || typeof id !== 'string' || !id
        || typeof idPrefix !== 'string' || !/^UG-UGNLIS-[A-Z0-9-]+-$/.test(idPrefix)
        || descriptor.idField !== 'id' || JSON.stringify(descriptor.outFields) !== '["id"]'
        || !selector || !['caddistrict', 'county', 'city'].every(key => typeof selector[key] === 'string' && /^[a-z0-9_]+$/.test(selector[key]))
        || typeof descriptor.municipalityLabel !== 'string' || !descriptor.municipalityLabel
        || descriptor.sourceCrs !== 'EPSG:21096' || descriptor.projection !== UGN_NATIVE_PROJECTION
        || !Number.isSafeInteger(maxFeatures) || maxFeatures < 1 || maxFeatures > 2000
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 45000
        || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8 || typeof fetchImpl !== 'function') {
        throw new Error('Invalid UgNLIS parcel source descriptor.');
    }
    let snapshot = null, pending = null;

    async function post(endpoint, block, plot, isFilterPlot) {
        const signal = AbortSignal.timeout(timeoutMs);
        try {
            return await readJson(await fetchImpl(endpoint, { method: 'POST', redirect: 'error', signal,
                headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify({ radioBlockRoad: 'block', ...selector, block, road: '', plot, isFilterPlot }) }));
        } catch (error) {
            if (error?.status) throw error;
            if (signal.aborted) throw upstreamError('UgNLIS parcel search timed out.', 504);
            throw upstreamError('UgNLIS parcel search failed.');
        }
    }

    function filterValues(payload, field) {
        if (!Array.isArray(payload) || payload.length > maxFeatures) throw upstreamError('UgNLIS selector list is invalid or exceeds the limit.');
        const values = payload.map(row => row?.[field]);
        if (values.some(value => !['string', 'number'].includes(typeof value) || String(value).length > 128
            || (typeof value === 'number' && !Number.isSafeInteger(value)))) throw upstreamError('UgNLIS returned an invalid parcel selector.');
        return [...new Set(values.map(String))];
    }

    async function readParcel(locator) {
        const record = await post(UGN_SOURCE_ENDPOINT, locator.block, locator.plot, false);
        if (!record || Array.isArray(record) || !NATIVE_ID.test(String(record.id ?? ''))
            || record.cad_muni_tc_city !== descriptor.municipalityLabel) throw upstreamError('UgNLIS parcel identity or municipality binding is invalid.');
        const nativeId = String(record.id);
        if (record.geometry === null) return { nativeId, locator, feature: null };
        let native;
        try { native = typeof record.geometry === 'string' ? JSON.parse(record.geometry) : record.geometry; }
        catch { throw upstreamError('UgNLIS returned invalid boundary JSON.'); }
        if (native?.type !== 'Feature' || String(native.id) !== nativeId) throw upstreamError('UgNLIS boundary identity differs from its parcel record.');
        if (native.geometry === null) return { nativeId, locator, feature: null };
        return { nativeId, locator, feature: canonicalParcelFeature(descriptor, {
            geometry: projectGeometry(native.geometry), properties: { id: nativeId }
        }, nativeId) };
    }

    async function enumerate() {
        const blocks = filterValues(await post(UGN_FILTER_ENDPOINT, '', '', false), 'block_number');
        if (!blocks.length) throw upstreamError('UgNLIS returned no municipality selectors; coverage is unknown.');
        const groups = await mapLimited(blocks, concurrency, async block => {
            const plots = filterValues(await post(UGN_FILTER_ENDPOINT, block, '', true), 'lot_number');
            return plots.map(plot => ({ block, plot }));
        });
        const locators = groups.flat();
        if (!locators.length || locators.length > maxFeatures) throw upstreamError('UgNLIS enumeration is empty or exceeds the parcel limit.');
        const rows = await mapLimited(locators, concurrency, readParcel);
        const byId = new Map();
        for (const row of rows) {
            const previous = byId.get(row.nativeId);
            if (previous && JSON.stringify(previous.feature?.geometry) !== JSON.stringify(row.feature?.geometry)) {
                throw upstreamError('UgNLIS returned conflicting boundaries for one native ID.');
            }
            if (!previous) byId.set(row.nativeId, row);
        }
        return { byId, features: [...byId.values()].flatMap(row => row.feature ? [row.feature] : []),
            nullGeometryCount: [...byId.values()].filter(row => !row.feature).length, fetchedAt: now() };
    }

    async function getSnapshot() {
        if (snapshot && now() - snapshot.fetchedAt < 60000) return snapshot;
        if (!pending) pending = enumerate().then(value => { snapshot = value; return value; }).finally(() => { pending = null; });
        return pending;
    }

    function collection(features, state) {
        return { type: 'FeatureCollection', sourceId: id, returnsWGS84: true, complete: true, features,
            coverage: { scope: 'published-municipality-block-plot-selectors', citywideCompleteness: false,
                nullGeometryCount: state.nullGeometryCount } };
    }

    async function queryBounds(bounds) {
        validateBounds(bounds, descriptor.maxBboxKm2 ?? 25, descriptor);
        const state = await getSnapshot();
        return collection(state.features.filter(feature => {
            const b = geometryBbox(feature);
            return b[0] <= bounds[2] && b[2] >= bounds[0] && b[1] <= bounds[3] && b[3] >= bounds[1];
        }), state);
    }

    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80 || ids.some(value => typeof value !== 'string'
            || !value.startsWith(idPrefix) || !NATIVE_ID.test(value.slice(idPrefix.length)))) throw new HttpError(400, 'Provide 1–80 native UgNLIS parcel IDs from this source.');
        const unique = [...new Set(ids)];
        const state = await getSnapshot();
        const rows = await mapLimited(unique, concurrency, async canonicalId => {
            const nativeId = canonicalId.slice(idPrefix.length), known = state.byId.get(nativeId);
            if (!known) return null;
            // Always re-fetch: the in-memory index is a locator, never an exact-read result.
            const row = await readParcel(known.locator);
            if (row.nativeId !== nativeId) throw upstreamError('UgNLIS selector no longer resolves the requested native parcel ID.');
            if (!row.feature) throw upstreamError('UgNLIS parcel record has no published boundary.', 502, 'parcel-source-geometry-unavailable');
            return row.feature;
        });
        const features = rows.filter(Boolean), found = new Set(features.map(feature => feature.id));
        return { ...collection(features, state), absentIds: unique.filter(value => !found.has(value)) };
    }

    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide a WGS84 parcel Polygon or MultiPolygon.');
        const result = await queryBounds(geometryBbox(turfFeature(geometry)));
        return { ...result, features: result.features.filter(feature => booleanIntersects(feature, turfFeature(geometry))) };
    }
    return Object.freeze({ queryBounds, queryIds, queryGeometry });
}

// The directory takes more requests than the byte relay's per-minute visitor budget.
// Run that bounded operation in the trusted relay instead of forwarding each lookup.
export function createUgnlisBrowserParcelSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    if (descriptor.browserTransport !== 'relay' || descriptor.endpoint !== UGN_SOURCE_ENDPOINT) throw new Error('UgNLIS browser reads require the registered relay.');
    async function query(operation, input, options = {}) {
        const response = await fetchImpl(UGN_SOURCE_ENDPOINT, { method: 'POST', redirect: 'error', signal: options.signal,
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ _ugnlisOperation: operation, input }) });
        const data = await readJson(response);
        if (data?.sourceId !== descriptor.id || data.type !== 'FeatureCollection' || data.complete !== true
            || data.returnsWGS84 !== true || !Array.isArray(data.features) || data.features.length > descriptor.maxFeatures) {
            throw upstreamError('UgNLIS relay returned an invalid parcel collection.');
        }
        const features = data.features.map(feature => {
            const nativeId = feature?.properties?.sourceParcelId;
            if (typeof nativeId !== 'string' || !NATIVE_ID.test(nativeId) || feature.id !== `${descriptor.idPrefix}${nativeId}`
                || feature.properties.sourceId !== descriptor.id || !validateGeometry(feature.geometry)) throw upstreamError('UgNLIS relay returned an invalid parcel.');
            return canonicalParcelFeature(descriptor, { geometry: feature.geometry, properties: { id: nativeId } }, nativeId);
        });
        if (new Set(features.map(feature => feature.id)).size !== features.length) throw upstreamError('UgNLIS relay repeated a parcel ID.');
        return { type: 'FeatureCollection', sourceId: descriptor.id, returnsWGS84: true, complete: true, features,
            coverage: { scope: 'published-municipality-block-plot-selectors', citywideCompleteness: false,
                nullGeometryCount: Number.isSafeInteger(data.coverage?.nullGeometryCount) ? data.coverage.nullGeometryCount : null },
            ...(data.absentIds ? { absentIds: data.absentIds } : {}) };
    }
    return Object.freeze({ queryBounds: (input, options) => query('bounds', input, options),
        queryIds: (input, options) => query('ids', input, options), queryGeometry: (input, options) => query('geometry', input, options) });
}
