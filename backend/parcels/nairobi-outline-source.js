// Streams public Nairobi Maps outlines with explicit geometry identities and fresh spatial re-reads.
import { bbox as geometryBbox, booleanIntersects, feature as geoFeature } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { upstreamError, providerHttpError, validateBounds, validateGeometry } from './source-contract.js';
import { geometryParcelFeature, parseGeometryParcelId, geometryLookupBounds, GEOMETRY_IDENTITY_KIND } from './geometry-identity.js';

export function createNairobiOutlineSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    const { id, idPrefix, endpoint } = descriptor;
    const maxFeatures = descriptor.maxFeatures ?? 4000;
    const maxBytes = descriptor.maxResponseBytes ?? 2 * 1024 * 1024;
    const lookupCellSize = descriptor.lookupCellSize ?? 0.0025;
    const zoom = 19;
    if (!id || !idPrefix || endpoint !== 'https://nairobimaps.com/api/get_parcels.php'
        || descriptor.identityKind !== GEOMETRY_IDENTITY_KIND || typeof fetchImpl !== 'function'
        || !Number.isSafeInteger(maxFeatures) || maxFeatures < 1 || maxFeatures > 4000
        || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 8 * 1024 * 1024
        || !Number.isFinite(lookupCellSize) || lookupCellSize < 0.0001 || lookupCellSize > 0.005) {
        throw new Error('Invalid Nairobi outline source descriptor.');
    }

    async function readJson(response) {
        if (Number(response.headers.get('content-length')) > maxBytes) throw upstreamError('Outline response exceeds byte limit.');
        if (!response.body?.getReader) throw upstreamError('Outline provider returned no readable response.');
        const reader = response.body.getReader(), chunks = [];
        let size = 0;
        try {
            for (;;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                size += chunk.value.byteLength;
                if (size > maxBytes) throw upstreamError('Outline response exceeds byte limit.');
                chunks.push(chunk.value);
            }
            return JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (error) {
            try { await reader.cancel(); } catch { /* The failed stream may already be closed. */ }
            throw error;
        } finally { reader.releaseLock(); }
    }

    function result(features, extra = {}) {
        return { type: 'FeatureCollection', features, sourceId: id, returnsWGS84: true, complete: true,
            identityKind: GEOMETRY_IDENTITY_KIND, ...extra };
    }

    async function boundsRead(bbox, signal) {
        validateBounds(bbox, descriptor.maxBboxKm2 ?? 1, descriptor);
        const url = new URL(endpoint);
        url.search = new URLSearchParams({ bbox: bbox.join(','), zoom: String(zoom) });
        let payload;
        try {
            const response = await fetchImpl(url.href, { signal, redirect: 'error',
                headers: { Accept: 'application/geo+json, application/json' } });
            if (response.status !== 200 || !response.ok) throw providerHttpError(response);
            payload = await readJson(response);
        } catch (error) {
            if (signal.aborted || ['AbortError', 'TimeoutError'].includes(error.name)) throw upstreamError('Outline provider timed out.', 504);
            if (error.status) throw error;
            throw upstreamError('Outline provider is unavailable.');
        }
        const metadata = payload?.metadata;
        if (payload?.type !== 'FeatureCollection' || !Array.isArray(payload.features)
            || payload.error || metadata?.error
            || !metadata || metadata.count !== payload.features.length || metadata.zoom !== zoom
            || !Number.isSafeInteger(metadata.limit) || metadata.limit < 1
            || metadata.truncated !== false || payload.complete === false
            || payload.features.length >= metadata.limit || payload.features.length > maxFeatures) {
            throw upstreamError('Outline provider returned incomplete or inconsistent coverage.');
        }
        if (payload.bbox !== undefined && (!Array.isArray(payload.bbox) || payload.bbox.length !== 4
            || payload.bbox.some((value, index) => typeof value !== 'number' || !Number.isFinite(value)
                || Math.abs(value - bbox[index]) > 1e-10))) {
            throw upstreamError('Outline provider changed the requested area.');
        }
        if (payload.crs && (payload.crs.type !== 'name' || ![
            'EPSG:4326', 'urn:ogc:def:crs:EPSG::4326', 'CRS:84', 'OGC:CRS84',
            'urn:ogc:def:crs:OGC::CRS84', 'urn:ogc:def:crs:OGC:1.3:CRS84'
        ].includes(payload.crs.properties?.name))) throw upstreamError('Outline provider returned a different coordinate system.');
        const unique = new Map();
        for (const feature of payload.features) {
            const canonical = geometryParcelFeature(descriptor, feature);
            const extent = geometryBbox(canonical);
            // The public endpoint selects intersecting feature envelopes, retaining the whole shape.
            if (extent[2] < bbox[0] || extent[0] > bbox[2] || extent[3] < bbox[1] || extent[1] > bbox[3]) {
                throw upstreamError('Outline provider returned geometry outside the requested area.');
            }
            unique.set(canonical.id, canonical);
        }
        return result([...unique.values()]);
    }

    function queryBounds(bbox) { return boundsRead(bbox, AbortSignal.timeout(15000)); }

    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80) throw new HttpError(400, 'Provide between 1 and 80 parcel IDs.');
        const unique = [...new Set(ids)];
        const groups = new Map();
        // Validate the entire request before sending any traffic. No process-local ID index is used.
        for (const parcelId of unique) {
            const locator = parseGeometryParcelId(descriptor, parcelId);
            const bbox = geometryLookupBounds(locator, lookupCellSize);
            validateBounds(bbox, descriptor.maxBboxKm2 ?? 1, descriptor);
            groups.set(bbox.join(','), bbox);
        }
        const signal = AbortSignal.timeout(15000), found = new Map();
        for (const bbox of groups.values()) {
            const response = await boundsRead(bbox, signal);
            for (const feature of response.features) if (unique.includes(feature.id)) found.set(feature.id, feature);
        }
        // Absence means this geometry version is absent; it never asserts a legal parcel ceased to exist.
        return result([...found.values()], { absentIds: unique.filter(parcelId => !found.has(parcelId)) });
    }

    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide a valid WGS84 Polygon or MultiPolygon.');
        const footprint = geoFeature(geometry);
        const response = await queryBounds(geometryBbox(footprint));
        return { ...response, features: response.features.filter(parcel => booleanIntersects(parcel, footprint)) };
    }
    return Object.freeze({ queryBounds, queryIds, queryGeometry });
}
