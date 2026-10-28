// Taichung's official viewer: spatial cadastral keys, followed by independent exact parcel reads.
import proj4 from 'proj4';
import { bbox, booleanIntersects, feature as turfFeature } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { concatBytes } from './byte-utils.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';

export const TAICHUNG_ENDPOINT = 'https://gismap.taichung.gov.tw/gismap/CFM/locate_land.cfm';
export const TAICHUNG_SPATIAL_ENDPOINT = 'https://gismap.taichung.gov.tw/gismap/CFM/queryparcel.cfm';
export const TAICHUNG_PROJECTION = '+proj=tmerc +lat_0=0 +lon_0=121 +k=0.9999 +x_0=250000 +y_0=0 +ellps=GRS80 +units=m +no_defs';
const PREFIX = 'TW-TC-GISMAP-G67:';
const NATIVE_ID = /^(\d{6}):(\d{4})-(\d{4})$/;
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

// Only parse numeric scalars. Never close, snap, simplify, reorder or otherwise repair rings.
export function taichungNativeGeometry(geometry) {
    if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) throw upstreamError('Taichung returned a non-polygon.');
    const scalar = value => {
        if (typeof value !== 'number' && (typeof value !== 'string' || !NUMBER.test(value))) throw upstreamError('Taichung returned a non-numeric coordinate.');
        const number = Number(value);
        if (!Number.isFinite(number)) throw upstreamError('Taichung returned a non-finite coordinate.');
        return number;
    };
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    if (!Array.isArray(polygons) || !polygons.length) throw upstreamError('Taichung returned empty polygon coordinates.');
    const converted = polygons.map(polygon => {
        if (!Array.isArray(polygon) || !polygon.length) throw upstreamError('Taichung returned an empty polygon.');
        return polygon.map(ring => {
            if (!Array.isArray(ring) || ring.length < 4) throw upstreamError('Taichung returned an unusable ring.');
            const points = ring.map(point => {
                if (!Array.isArray(point) || point.length !== 2) throw upstreamError('Taichung returned unsupported coordinate dimensions.');
                return point.map(scalar);
            });
            if (points[0][0] !== points.at(-1)[0] || points[0][1] !== points.at(-1)[1]) throw upstreamError('Taichung returned an open ring; no repair applied.');
            return points;
        });
    });
    return { type: geometry.type, coordinates: geometry.type === 'Polygon' ? converted[0] : converted };
}

export function createTaichungBrowserParcelSource(descriptor, options = {}) {
    return createTaichungParcelSource(descriptor, { ...options, batchExactReads: true });
}

export function createTaichungParcelSource(descriptor, { fetchImpl = globalThis.fetch, batchExactReads = false } = {}) {
    const maxBytes = descriptor.maxResponseBytes ?? 8 * 1024 * 1024;
    const maxFeatures = descriptor.maxFeatures ?? 300;
    const maxKm2 = descriptor.maxBboxKm2 ?? 1;
    const sections = descriptor.sectionCodes;
    if (descriptor.id !== 'tw-taichung-gismap-cadastral-parcels' || descriptor.adapter !== 'taichung-gismap'
        || descriptor.endpoint !== TAICHUNG_ENDPOINT || descriptor.spatialEndpoint !== TAICHUNG_SPATIAL_ENDPOINT
        || descriptor.idPrefix !== PREFIX || descriptor.sourceCrs !== 'EPSG:3826'
        || descriptor.outFields?.length !== 1 || descriptor.outFields[0] !== '地段號'
        || descriptor.parcelNumberField !== '地段號' || typeof fetchImpl !== 'function'
        || !Array.isArray(sections) || !sections.length || sections.length > 2000 || sections.some(code => !/^\d{6}$/.test(code))
        || new Set(sections.map(code => code.slice(2))).size !== sections.length
        || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 16 * 1024 * 1024
        || !Number.isSafeInteger(maxFeatures) || maxFeatures < 1 || maxFeatures > 1000
        || !Number.isFinite(maxKm2) || maxKm2 <= 0 || maxKm2 > 1) throw new Error('Invalid Taichung parcel source descriptor.');
    const sectionMap = new Map(sections.map(code => [code.slice(2), code]));
    const projection = proj4(TAICHUNG_PROJECTION, 'EPSG:4326');
    const result = (features, extra = {}) => ({ type: 'FeatureCollection', sourceId: descriptor.id, features,
        complete: true, returnsWGS84: true, areaComplete: false, authoritativeAbsence: false, ...extra });
    // Bounded, short-lived identity associations only. Exact-ID calls always fetch the provider.
    const identities = new Map();
    let active = 0;
    const waiting = [];
    async function post(url, body, options) {
        if (active >= 4) await new Promise(resolve => waiting.push(resolve));
        else active++;
        const signal = options?.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000);
        try {
            const response = await fetchImpl(url, { method: 'POST', redirect: 'error', cache: 'no-store', signal,
                headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams(body).toString() });
            if (!response.ok) throw providerHttpError(response);
            if (Number(response.headers.get('content-length')) > maxBytes || !response.body?.getReader) throw upstreamError('Taichung response exceeds the byte limit or has no readable body.');
            const reader = response.body.getReader(), chunks = [];
            let bytes = 0;
            try {
                for (;;) {
                    const chunk = await reader.read();
                    if (chunk.done) break;
                    bytes += chunk.value.byteLength;
                    if (bytes > maxBytes) throw upstreamError('Taichung response exceeds the byte limit.');
                    chunks.push(chunk.value);
                }
                return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(concatBytes(chunks, bytes)).replace(/^\uFEFF/, ''));
            } catch (error) { await reader.cancel().catch(() => {}); throw error; }
            finally { reader.releaseLock(); }
        } finally {
            const next = waiting.shift();
            if (next) next(); else active--;
        }
    }
    function geographic(native) {
        const convert = values => typeof values[0] === 'number' ? projection.forward(values) : values.map(convert);
        const geometry = { type: native.type, coordinates: convert(native.coordinates) };
        if (!validateGeometry(geometry)) throw upstreamError('Taichung polygon is unusable after projection; no repair applied.');
        return geometry;
    }
    function remember(native, id) {
        identities.delete(id);
        identities.set(id, { key: JSON.stringify(native), at: Date.now() });
        while (identities.size > 2000) identities.delete(identities.keys().next().value);
    }
    function parseExact(id, payload) {
        const nativeId = id.slice(PREFIX.length), match = NATIVE_ID.exec(nativeId);
        if (payload?.type !== 'FeatureCollection' || !Array.isArray(payload.features) || payload.features.length > 1) throw upstreamError('Taichung exact lookup returned an invalid collection.');
        if (!payload.features.length) return null;
        const row = payload.features[0], label = row.properties?.['地段號'];
        const parcel = typeof label === 'string' && /(\d+)-(\d+)地號$/.exec(label);
        if (!parcel || Number(parcel[1]) !== Number(match[2]) || Number(parcel[2]) !== Number(match[3])) throw upstreamError('Taichung parcel label disagrees with the exact composite request.');
        const native = taichungNativeGeometry(row.geometry);
        remember(native, id);
        return { native, sourceGeometry: row.geometry, label, feature: canonicalParcelFeature(descriptor,
            { geometry: geographic(native), properties: { '地段號': label } }, nativeId) };
    }
    async function exact(id, options) {
        const match = NATIVE_ID.exec(id.slice(PREFIX.length));
        return parseExact(id, await post(TAICHUNG_ENDPOINT, { key_no: match[1] + match[2] + match[3] }, options));
    }
    async function mapLimited(values, fn) {
        let cursor = 0, failure;
        const output = new Array(values.length);
        await Promise.all(Array.from({ length: Math.min(4, values.length) }, async () => {
            while (!failure) {
                const i = cursor++;
                if (i >= values.length) return;
                try { output[i] = await fn(values[i]); } catch (error) { failure = error; }
            }
        }));
        if (failure) throw failure;
        return output;
    }
    function validateIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80 || new Set(ids).size !== ids.length
            || ids.some(id => typeof id !== 'string' || !id.startsWith(PREFIX) || !NATIVE_ID.test(id.slice(PREFIX.length)))) throw new HttpError(400, 'Expected 1–80 unique Taichung composite parcel IDs.');
    }
    async function exactMany(ids, options) {
        if (!batchExactReads) return mapLimited(ids, id => exact(id, options));
        const rows = [];
        for (let start = 0; start < ids.length; start += 80) {
            const batch = ids.slice(start, start + 80);
            // This envelope is a local relay operation, never a request sent to the provider.
            const payload = await post(TAICHUNG_ENDPOINT, { _parcelIds: JSON.stringify(batch) }, options);
            if (payload?.type !== 'TaichungNativeBatch' || payload.sourceId !== descriptor.id || !Array.isArray(payload.results)
                || payload.results.length !== batch.length || payload.results.some((row, index) => row?.id !== batch[index])) throw upstreamError('Taichung relay returned an invalid native batch.');
            rows.push(...payload.results.map(row => parseExact(row.id,
                { type:'FeatureCollection', features: row.geometry ? [{geometry:row.geometry,properties:row.properties}] : [] })));
        }
        return rows;
    }
    // Used only by the trusted relay to batch fresh exact lookups. Original wire geometry is retained.
    async function queryNativeIds(ids, options = {}) {
        validateIds(ids);
        const rows = await mapLimited(ids, id => exact(id, options));
        return { type:'TaichungNativeBatch', sourceId:descriptor.id, results:rows.map((row, index) => ({ id:ids[index],
            ...(row ? { geometry:row.sourceGeometry, properties:{ '地段號':row.label } } : {geometry:null}) })) };
    }
    async function queryIds(ids, options = {}) {
        validateIds(ids);
        const rows = await exactMany(ids, options);
        const unresolvedIds = ids.filter((_id, index) => !rows[index]);
        return result(rows.filter(Boolean).map(row => row.feature), { complete: unresolvedIds.length === 0, absentIds: [], unresolvedIds });
    }
    async function queryBounds(bounds, options = {}) {
        validateBounds(bounds, maxKm2);
        const [w, s, e, n] = bounds;
        const points = [[w,s],[e,s],[e,n],[w,n],[w,s]].map(point => projection.inverse(point));
        const payload = await post(TAICHUNG_SPATIAL_ENDPOINT,
            { wkt: `POLYGON((${points.map(point => point.join(' ')).join(',')}))`, gtype: 'Polygon' }, options);
        if (payload?.type !== 'FeatureCollection' || !Array.isArray(payload.features) || !Array.isArray(payload.DATA)
            || !Number.isSafeInteger(payload.CNT) || payload.CNT !== payload.DATA.length || payload.CNT !== payload.features.length
            || payload.CNT >= maxFeatures) throw upstreamError('Taichung spatial response is inconsistent or reached the transfer cap; request smaller cells.');
        const ids = payload.DATA.map(row => {
            const section = sectionMap.get(row.AA48);
            if (!section || typeof row.AA49 !== 'string' || !/^\d{8}$/.test(row.AA49)) throw upstreamError('Taichung returned an unknown section or malformed parcel key.');
            return `${PREFIX}${section}:${row.AA49.slice(0, 4)}-${row.AA49.slice(4)}`;
        });
        if (new Set(ids).size !== ids.length) throw upstreamError('Taichung spatial response contains duplicate composite IDs.');
        const found = new Map();
        const natives = payload.features.map(row => taichungNativeGeometry(row.geometry));
        const nativeByKey = new Map(natives.map(native => [JSON.stringify(native), native]));
        for (const id of ids) {
            const known = identities.get(id), native = known && nativeByKey.get(known.key);
            if (native && Date.now() - known.at < 60000) {
                found.set(id, canonicalParcelFeature(descriptor, { geometry: geographic(native) }, id.slice(PREFIX.length)));
            }
        }
        const fresh = await exactMany(ids.filter(id => !found.has(id)), options);
        for (const row of fresh) if (row) found.set(row.feature.id, row.feature);
        // The two independent routes must return the same polygons. No positional join is used.
        const exactKeys = ids.map(id => identities.get(id)?.key).sort();
        const spatialKeys = natives.map(native => JSON.stringify(native)).sort();
        if (found.size !== ids.length || JSON.stringify(exactKeys) !== JSON.stringify(spatialKeys)) throw upstreamError('Taichung spatial/exact polygon correspondence could not be verified.');
        return result(ids.map(id => found.get(id)), { queryType: 'bounds',
            completenessReason: 'Bounded spatial response and independent exact polygons agree; no citywide coverage or absence claim.' });
    }
    async function queryGeometry(geometry, options = {}) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Expected a WGS84 polygon.');
        const response = await queryBounds(bbox(turfFeature(geometry)), options);
        return { ...response, features: response.features.filter(row => booleanIntersects(row, turfFeature(geometry))) };
    }
    return { queryIds, queryBounds, queryGeometry, queryNativeIds };
}
