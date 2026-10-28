// Bounded Huainan cadastral geometry reads. Exact reads requery a location and match the native
// ID; a missing localized match is unresolved, never authoritative parcel absence.
import { bbox, booleanIntersects, feature as turfFeature } from '@turf/turf';
import { concatBytes } from './byte-utils.js';
import { parseUldkPolygonWkt } from './pl-uldk-point-source.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';

export const HUAINAN_ENDPOINT = 'https://mapshine.cn/hnbdc/Zongdi/SpatialQuery';
const SOURCE = 'cn-huainan-mapshine-cadastral-parcels';
const PREFIX = 'CN-HUAINAN-ZD-';
const invalid = () => upstreamError('Huainan returned malformed, duplicate or truncated parcel geometry.');
const badQuery = () => Object.assign(new Error('Invalid Huainan parcel query.'), { status: 400, code: 'invalid-parcel-query' });
const nativeId = value => typeof value === 'number'
    ? Number.isSafeInteger(value) && value >= 0 ? String(value) : null
    : typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) ? value : null;
const validPoint = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)
    && Math.abs(value[0]) < 180 && Math.abs(value[1]) < 90;

export function createHuainanMapshineParcelSource(descriptor, { fetchImpl = globalThis.fetch, onRead } = {}) {
    const maxBytes = descriptor.maxResponseBytes ?? 1024 * 1024;
    const maxFeatures = descriptor.maxFeatures ?? 500;
    const maxKm2 = descriptor.maxBboxKm2 ?? 2;
    const halfSize = descriptor.lookupHalfSizeDegrees ?? 0.001;
    if (descriptor.id !== SOURCE || descriptor.adapter !== 'huainan-mapshine'
        || descriptor.endpoint !== HUAINAN_ENDPOINT || descriptor.idPrefix !== PREFIX
        || descriptor.idField !== 'id' || descriptor.geometryField !== 'geom'
        || descriptor.sourceCrs !== 'EPSG:4326' || descriptor.outFields?.length !== 1 || descriptor.outFields[0] !== 'id'
        || !validPoint(descriptor.lookupPoint) || typeof fetchImpl !== 'function'
        || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 16 * 1024 * 1024
        || !Number.isSafeInteger(maxFeatures) || maxFeatures < 1 || maxFeatures > 2000
        || !Number.isFinite(maxKm2) || maxKm2 <= 0 || maxKm2 > 2
        || !Number.isFinite(halfSize) || halfSize <= 0 || halfSize > 0.001) throw new Error('Invalid Huainan source descriptor.');
    // Store spatial hints, never cached exact-read answers. Cold IDs need a nearby point;
    // the configured city entry is only a bounded initial search, not a global ID directory.
    const locations = new Map();
    const result = (features, extra = {}) => ({ type: 'FeatureCollection', features, sourceId: SOURCE,
        complete: true, returnsWGS84: true, areaComplete: false, authoritativeAbsence: false, ...extra });
    const windowAt = ([x,y]) => [x-halfSize,y-halfSize,x+halfSize,y+halfSize];

    async function read(bounds, { signal } = {}) {
        const [w,s,e,n] = validateBounds(bounds, maxKm2);
        const geoWkt = `POLYGON ((${w} ${s},${e} ${s},${e} ${n},${w} ${n},${w} ${s}))`;
        const timeout = AbortSignal.timeout(30000);
        const response = await fetchImpl(HUAINAN_ENDPOINT, { method: 'POST', credentials: 'omit', redirect: 'error',
            cache: 'no-store', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
            headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ geoWkt }).toString() });
        if (!response.ok) throw providerHttpError(response);
        if (Number(response.headers.get('content-length')) > maxBytes) {
            await response.body?.cancel(); throw invalid();
        }
        const reader = response.body?.getReader();
        if (!reader) throw invalid();
        let bytes = 0;
        const chunks = [];
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                bytes += value.byteLength;
                if (bytes > maxBytes) throw invalid();
                chunks.push(value);
            }
        } catch (error) { await reader.cancel().catch(() => {}); throw error; }
        finally { reader.releaseLock(); }
        let rows;
        try { rows = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(concatBytes(chunks, bytes))); }
        catch { throw invalid(); }
        if (!Array.isArray(rows) || rows.length >= maxFeatures) throw invalid();
        const seen = new Set();
        const boundsFeature = turfFeature({ type: 'Polygon', coordinates: [[[w,s],[e,s],[e,n],[w,n],[w,s]]] });
        const features = rows.map(row => {
            // The fixed provider response contains incidental registration attributes. Discard all
            // of them immediately; never visit AttributeBox or the registration search routes.
            const key = nativeId(row?.id);
            if (key === null || seen.has(key) || typeof row.geom !== 'string' || row.geom.length > 1000000) throw invalid();
            seen.add(key);
            const geometry = parseUldkPolygonWkt(row.geom.trim());
            if (!validateGeometry(geometry) || !booleanIntersects(turfFeature(geometry), boundsFeature)) throw invalid();
            return canonicalParcelFeature(descriptor, { geometry, properties: { id: key } }, key);
        });
        for (const feature of features) {
            locations.delete(feature.id); locations.set(feature.id, [...bounds]);
            if (locations.size > 2000) locations.delete(locations.keys().next().value);
        }
        onRead?.({ bounds: [...bounds], bytes, featureCount: features.length });
        return features;
    }

    async function queryBounds(bounds, options = {}) { return result(await read(bounds, options), { queryType: 'bounds' }); }

    async function queryIds(ids, options = {}) {
        if (!Array.isArray(ids) || ids.length > 80 || new Set(ids).size !== ids.length
            || ids.some(id => typeof id !== 'string' || !id.startsWith(PREFIX) || nativeId(id.slice(PREFIX.length)) === null)
            || options.near !== undefined && !validPoint(options.near)) throw badQuery();
        const groups = new Map();
        for (const id of ids) {
            const bounds = locations.get(id) || windowAt(options.near ?? descriptor.lookupPoint);
            const key = JSON.stringify(bounds);
            if (!groups.has(key)) groups.set(key, { bounds, ids: [] });
            groups.get(key).ids.push(id);
        }
        const features = [], unresolvedIds = [];
        for (const group of groups.values()) {
            // Every invocation fetches fresh source geometry, even when a hint was learned earlier.
            const found = new Map((await read(group.bounds, options)).map(feature => [feature.id, feature]));
            for (const id of group.ids) {
                if (found.has(id)) features.push(found.get(id)); else unresolvedIds.push(id);
            }
        }
        return result(features, { queryType: 'ids', complete: !unresolvedIds.length, absentIds: [], unresolvedIds });
    }

    async function queryGeometry(geometry, options = {}) {
        if (!validateGeometry(geometry)) throw badQuery();
        const features = await read(bbox(turfFeature(geometry)), options);
        return result(features.filter(feature => booleanIntersects(feature, turfFeature(geometry))), { queryType: 'geometry' });
    }
    return Object.freeze({ queryBounds, queryIds, queryGeometry });
}
