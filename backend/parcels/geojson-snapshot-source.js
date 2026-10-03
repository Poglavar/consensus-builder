// Reads bounded public GeoJSON snapshots into a short-lived memory index; never writes parcels to disk or a database.
import { bbox as geometryBbox, bboxPolygon, booleanIntersects, feature as geoFeature } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { canonicalParcelFeature, upstreamError, providerHttpError, validateBounds, validateGeometry } from './source-contract.js';

const caches = new WeakMap();
const CACHE_MS = 5 * 60 * 1000;
const encodePart = value => encodeURIComponent(value).replaceAll('~', '%7E');
const validPart = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value;
const validExtent = value => Array.isArray(value) && value.length === 4 && value.every(Number.isFinite)
    && value[0] >= -180 && value[2] <= 180 && value[1] >= -90 && value[3] <= 90
    && value[0] < value[2] && value[1] < value[3];
const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

function createMultiSnapshotSource(descriptor, options) {
    const resources = descriptor.snapshots;
    if (!Array.isArray(resources) || !resources.length || resources.length > 80
        || !Array.isArray(descriptor.idFields)) throw new Error('Invalid parcel snapshot resources.');
    const namespaceField = resources[0]?.idNamespace?.field;
    if (!descriptor.idFields.includes(namespaceField)
        || resources.some(resource => !validExtent(resource.bbox) || resource.idNamespace?.field !== namespaceField
            || !validPart(resource.idNamespace?.value) || resource.expectedEtag === undefined
            || resource.expectedSnapshotFeatures === undefined)
        || new Set(resources.map(resource => resource.idNamespace.value)).size !== resources.length
        || new Set(resources.map(resource => resource.endpoint)).size !== resources.length) {
        throw new Error('Invalid parcel snapshot namespaces or extents.');
    }
    const children = resources.map(resource => ({ resource, adapter: createGeojsonSnapshotParcelSource({
        ...descriptor, ...resource, snapshots: undefined
    }, options) }));
    const maxFeatures = descriptor.maxFeatures ?? 10000;
    function combine(results, extra = {}) {
        const byId = new Map();
        for (const result of results) {
            if (!result.complete) throw upstreamError('Parcel snapshot returned incomplete coverage.');
            for (const feature of result.features) {
                const old = byId.get(feature.id);
                if (old && JSON.stringify(old.geometry) !== JSON.stringify(feature.geometry)) {
                    throw upstreamError('Parcel snapshots returned conflicting native identity.');
                }
                byId.set(feature.id, feature);
            }
        }
        if (byId.size > maxFeatures) throw upstreamError('Parcel query exceeds feature limit.');
        return { type: 'FeatureCollection', features: [...byId.values()], complete: true,
            sourceId: descriptor.id, returnsWGS84: true, ...extra };
    }
    async function queryBounds(bbox) {
        validateBounds(bbox, descriptor.maxBboxKm2 || 25, descriptor);
        return combine(await Promise.all(children.filter(child => overlaps(child.resource.bbox, bbox))
            .map(child => child.adapter.queryBounds(bbox))));
    }
    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide a valid WGS84 Polygon or MultiPolygon.');
        const bbox = geometryBbox(geoFeature(geometry));
        validateBounds(bbox, descriptor.maxBboxKm2 || 25, descriptor);
        return combine(await Promise.all(children.filter(child => overlaps(child.resource.bbox, bbox))
            .map(child => child.adapter.queryGeometry(geometry))));
    }
    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80) throw new HttpError(400, 'Provide between 1 and 80 parcel IDs.');
        const unique = [...new Set(ids)], groups = new Map();
        // Validate the whole request before any resource fetch, including unknown namespaces.
        for (const id of unique) {
            if (typeof id !== 'string' || !id.startsWith(descriptor.idPrefix)) throw new HttpError(400, 'Parcel ID belongs to a different source.');
            const parts = decodeSnapshotNativeId(id.slice(descriptor.idPrefix.length), descriptor.idFields.length);
            const namespace = parts[descriptor.idFields.indexOf(namespaceField)];
            const child = children.find(item => item.resource.idNamespace.value === namespace);
            if (child) { if (!groups.has(child)) groups.set(child, []); groups.get(child).push(id); }
        }
        const result = combine(await Promise.all([...groups].map(([child, group]) => child.adapter.queryIds(group))));
        const found = new Set(result.features.map(feature => feature.id));
        return { ...result, absentIds: unique.filter(id => !found.has(id)) };
    }
    return Object.freeze({ queryBounds, queryIds, queryGeometry });
}

export function encodeSnapshotNativeId(values) {
    if (!Array.isArray(values) || !values.length || values.some(value =>
        !validPart(value) && !(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0))) {
        throw new HttpError(400, 'Invalid snapshot parcel identity.');
    }
    try { return values.map(value => encodePart(String(value))).join('~'); }
    catch (_) { throw new HttpError(400, 'Invalid snapshot parcel identity.'); }
}

export function decodeSnapshotNativeId(value, componentCount) {
    try {
        if (typeof value !== 'string' || value.length > 4096) throw new Error();
        const parts = value.split('~').map(decodeURIComponent);
        if (parts.length !== componentCount || parts.some(part => !validPart(part))
            || encodeSnapshotNativeId(parts) !== value) throw new Error();
        return parts;
    } catch (_) { throw new HttpError(400, 'Invalid snapshot parcel ID.'); }
}

export function createGeojsonSnapshotParcelSource(descriptor, { fetchImpl = fetch, now = Date.now } = {}) {
    if (descriptor.snapshots !== undefined) return createMultiSnapshotSource(descriptor, { fetchImpl, now });
    const { id, endpoint, idPrefix, idFields, outFields } = descriptor;
    const maxSnapshotBytes = descriptor.maxSnapshotBytes ?? 3 * 1024 * 1024;
    const maxSnapshotFeatures = descriptor.maxSnapshotFeatures ?? 5000;
    const maxFeatures = descriptor.maxFeatures ?? 10000;
    const limits = [maxSnapshotBytes, maxSnapshotFeatures, maxFeatures];
    const url = new URL(endpoint);
    if (!id || !idPrefix || url.protocol !== 'https:' || url.username || url.password
        || typeof fetchImpl !== 'function' || typeof now !== 'function'
        || !Array.isArray(idFields) || !idFields.length || idFields.length > 8
        || new Set(idFields).size !== idFields.length || idFields.some(field => typeof field !== 'string' || !field)
        || !Array.isArray(outFields) || idFields.some(field => !outFields.includes(field))
        || (descriptor.parcelNumberField && !outFields.includes(descriptor.parcelNumberField))
        || (descriptor.expectedSnapshotFeatures !== undefined && (!Number.isSafeInteger(descriptor.expectedSnapshotFeatures)
            || descriptor.expectedSnapshotFeatures < 0 || descriptor.expectedSnapshotFeatures > maxSnapshotFeatures))
        || (descriptor.expectedEtag !== undefined && (typeof descriptor.expectedEtag !== 'string'
            || !/^"[^"\r\n]+"$/.test(descriptor.expectedEtag)))
        || (descriptor.idNamespace !== undefined && (!idFields.includes(descriptor.idNamespace?.field)
            || !validPart(descriptor.idNamespace?.value)))
        || (descriptor.bbox !== undefined && !validExtent(descriptor.bbox))
        || limits.some(limit => !Number.isSafeInteger(limit) || limit <= 0)) {
        throw new Error('Invalid GeoJSON snapshot parcel source descriptor.');
    }
    let instances = caches.get(fetchImpl);
    if (!instances) { instances = new Map(); caches.set(fetchImpl, instances); }
    const cacheKey = JSON.stringify(descriptor);
    let state = instances.get(cacheKey);
    if (!state) { state = { snapshot: null, expires: 0, pending: null }; instances.set(cacheKey, state); }

    async function load() {
        const signal = AbortSignal.timeout(15000);
        let reader;
        try {
            const response = await fetchImpl(endpoint, { signal, headers: { Accept: 'application/geo+json, application/json' } });
            if (!response.ok || response.status !== 200) throw providerHttpError(response);
            if (response.url && new URL(response.url).protocol !== 'https:') throw upstreamError('Snapshot redirected outside HTTPS.');
            if (descriptor.expectedEtag !== undefined && response.headers.get('etag') !== descriptor.expectedEtag) {
                throw upstreamError('Parcel snapshot revision does not match its verified release.');
            }
            const declaredLength = response.headers.get('content-length');
            if (declaredLength && Number(declaredLength) > maxSnapshotBytes) throw upstreamError('Parcel snapshot exceeds byte limit.');
            if (!response.body?.getReader) throw upstreamError('Snapshot provider returned no readable body.');
            reader = response.body.getReader();
            const chunks = [];
            let length = 0;
            for (;;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                length += chunk.value.byteLength;
                if (length > maxSnapshotBytes) throw upstreamError('Parcel snapshot exceeds byte limit.');
                chunks.push(chunk.value);
            }
            if (declaredLength && !response.headers.get('content-encoding') && Number(declaredLength) !== length) {
                throw upstreamError('Parcel snapshot content length does not match its body.');
            }
            const bytes = new Uint8Array(length);
            let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
            const collection = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
            if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) throw upstreamError('Invalid parcel snapshot collection.');
            if (collection.exceededTransferLimit === true || collection.complete === false) throw upstreamError('Parcel snapshot reports incomplete coverage.');
            const crs = collection.crs?.properties?.name;
            if (collection.crs && (collection.crs.type !== 'name' || ![
                'urn:ogc:def:crs:OGC::CRS84', 'urn:ogc:def:crs:OGC:1.3:CRS84', 'OGC:CRS84', 'CRS84',
                'EPSG:4326', 'urn:ogc:def:crs:EPSG::4326'
            ].includes(crs))) throw upstreamError('Parcel snapshot must use WGS84 GeoJSON coordinates.');
            if (collection.features.length > maxSnapshotFeatures) throw upstreamError('Parcel snapshot exceeds feature limit.');
            if (descriptor.expectedSnapshotFeatures !== undefined && collection.features.length !== descriptor.expectedSnapshotFeatures) {
                throw upstreamError('Parcel snapshot count does not match its verified release.');
            }
            const byId = new Map(), indexed = [];
            for (const feature of collection.features) {
                if (feature?.type !== 'Feature' || !validateGeometry(feature.geometry)) throw upstreamError('Parcel snapshot returned invalid polygon geometry.');
                if (descriptor.idNamespace && String(feature.properties?.[descriptor.idNamespace.field]) !== descriptor.idNamespace.value) {
                    throw upstreamError('Parcel snapshot returned a foreign native namespace.');
                }
                const extent = geometryBbox(feature);
                if (descriptor.bbox && (extent[0] < descriptor.bbox[0] || extent[1] < descriptor.bbox[1]
                    || extent[2] > descriptor.bbox[2] || extent[3] > descriptor.bbox[3])) {
                    throw upstreamError('Parcel snapshot polygon lies outside its verified extent.');
                }
                let nativeId;
                try { nativeId = encodeSnapshotNativeId(idFields.map(field => feature.properties?.[field])); }
                catch (_) { throw upstreamError('Parcel snapshot returned invalid native parcel identity.'); }
                const canonical = canonicalParcelFeature(descriptor, feature, nativeId);
                if (byId.has(canonical.id)) throw upstreamError('Parcel snapshot repeated a native parcel identity.');
                byId.set(canonical.id, canonical);
                indexed.push({ feature: canonical, bbox: geometryBbox(canonical) });
            }
            return { byId, indexed };
        } catch (error) {
            if (reader) { try { await reader.cancel(); } catch (_) { /* The failed stream may already be closed. */ } }
            if (error.status) throw error;
            if (signal.aborted || ['AbortError', 'TimeoutError'].includes(error.name)) throw upstreamError('Parcel snapshot provider timed out.', 504);
            throw upstreamError('Parcel snapshot provider is unavailable.');
        } finally { reader?.releaseLock(); }
    }

    async function snapshot() {
        if (state.snapshot && now() < state.expires) return state.snapshot;
        if (!state.pending) {
            state.snapshot = null;
            state.pending = load().then(value => {
                state.snapshot = value; state.expires = now() + CACHE_MS; return value;
            }).finally(() => { state.pending = null; });
        }
        return state.pending;
    }
    function result(features, extra = {}) {
        if (features.length > maxFeatures) throw upstreamError('Parcel query exceeds feature limit.');
        return { type: 'FeatureCollection', features: structuredClone(features), complete: true, sourceId: id, returnsWGS84: true, ...extra };
    }
    async function intersect(geometry, bbox) {
        const data = await snapshot();
        const target = geoFeature(geometry);
        try {
            return result(data.indexed.filter(item => item.bbox[0] <= bbox[2] && item.bbox[2] >= bbox[0]
                && item.bbox[1] <= bbox[3] && item.bbox[3] >= bbox[1]
                && booleanIntersects(item.feature, target)).map(item => item.feature));
        } catch (error) { if (error.status) throw error; throw upstreamError('Parcel snapshot intersection failed.'); }
    }
    function queryBounds(bbox) {
        validateBounds(bbox, descriptor.maxBboxKm2 || 25, descriptor);
        return intersect(bboxPolygon(bbox).geometry, bbox);
    }
    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80) throw new HttpError(400, 'Provide between 1 and 80 parcel IDs.');
        const unique = [...new Set(ids)];
        for (const value of unique) {
            if (typeof value !== 'string' || !value.startsWith(idPrefix)) throw new HttpError(400, 'Parcel ID belongs to a different source.');
            decodeSnapshotNativeId(value.slice(idPrefix.length), idFields.length);
        }
        const data = await snapshot();
        return result(unique.filter(value => data.byId.has(value)).map(value => data.byId.get(value)),
            { absentIds: unique.filter(value => !data.byId.has(value)) });
    }
    function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide a valid WGS84 Polygon or MultiPolygon.');
        const bbox = geometryBbox(geoFeature(geometry));
        validateBounds(bbox, descriptor.maxBboxKm2 || 25, descriptor);
        return intersect(geometry, bbox);
    }
    return Object.freeze({ queryBounds, queryIds, queryGeometry });
}
