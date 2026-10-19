// Reads unchanged DGI cadastral GeoJSON and resolves native IDs through fresh, bounded scans.
import { bbox as geometryBbox, booleanIntersects, feature as geoFeature } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { concatBytes } from './byte-utils.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';

const ENDPOINT = 'https://ecadastre.dgi.bf/api/locations/geojson';
const NATIVE_ID = /^[A-Za-z0-9]{1,64}$/;
const contains = (outer, inner) => outer[0] <= inner[0] && outer[1] <= inner[1]
    && outer[2] >= inner[2] && outer[3] >= inner[3];

export function createBfDgiParcelSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    const { id, idPrefix, endpoint } = descriptor;
    const maxBytes = descriptor.maxResponseBytes ?? 8 * 1024 * 1024;
    const maxBboxKm2 = descriptor.maxBboxKm2 ?? 2;
    if (!id || !idPrefix || endpoint !== ENDPOINT || descriptor.idField !== 'FID'
        || !Array.isArray(descriptor.outFields) || descriptor.outFields.length !== 1 || descriptor.outFields[0] !== 'FID'
        || !Array.isArray(descriptor.lookupBounds) || !descriptor.lookupBounds.length || descriptor.lookupBounds.length > 16
        || !Number.isFinite(maxBboxKm2) || maxBboxKm2 <= 0 || maxBboxKm2 > 25
        || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 16 * 1024 * 1024
        || typeof fetchImpl !== 'function') throw new Error('Invalid DGI parcel source descriptor.');
    const lookupBounds = descriptor.lookupBounds.map(bbox => [...validateBounds(bbox, maxBboxKm2)]);

    async function readJson(response) {
        if (Number(response.headers.get('content-length')) > maxBytes) throw upstreamError('DGI response exceeds byte limit.');
        if (!response.body?.getReader) throw upstreamError('DGI returned no readable response.');
        const reader = response.body.getReader(), chunks = [];
        let size = 0;
        try {
            for (;;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                size += chunk.value.byteLength;
                if (size > maxBytes) throw upstreamError('DGI response exceeds byte limit.');
                chunks.push(chunk.value);
            }
            return JSON.parse(new TextDecoder().decode(concatBytes(chunks, size)));
        } catch (error) {
            try { await reader.cancel(); } catch { /* A failed stream may already be closed. */ }
            throw error;
        } finally { reader.releaseLock(); }
    }

    const result = (features, extra = {}) => ({ type: 'FeatureCollection', features, sourceId: id,
        returnsWGS84: true, complete: false, completenessReason: 'Provider publishes no total or truncation metadata.', ...extra });

    async function readBounds(bbox, signal) {
        validateBounds(bbox, maxBboxKm2);
        if (!lookupBounds.some(scope => contains(scope, bbox))) throw new HttpError(400, 'Bounds exceed the configured DGI lookup scope.');
        const url = new URL(endpoint);
        url.search = new URLSearchParams({ minX: String(bbox[0]), minY: String(bbox[1]),
            maxX: String(bbox[2]), maxY: String(bbox[3]), type: 'PLOT' });
        let payload;
        try {
            const response = await fetchImpl(url.href, { signal, redirect: 'error',
                headers: { Accept: 'application/geo+json, application/json' } });
            if (!response.ok || response.status !== 200) throw providerHttpError(response);
            payload = await readJson(response);
        } catch (error) {
            if (error.status) throw error;
            if (signal.aborted) throw upstreamError('DGI request timed out.', 504);
            throw upstreamError('DGI parcel response is unavailable or malformed.');
        }
        if (payload?.type !== 'FeatureCollection' || !Array.isArray(payload.features) || payload.error
            || payload.features.length > 1000 || payload.complete === false
            || (payload.crs && !['EPSG:4326', 'urn:ogc:def:crs:EPSG::4326', 'CRS:84',
                'urn:ogc:def:crs:OGC:1.3:CRS84'].includes(payload.crs.properties?.name))) {
            throw upstreamError('DGI returned an invalid collection or coordinate system.');
        }
        const found = new Map();
        for (const row of payload.features) {
            const nativeId = row?.id;
            if (row?.type !== 'Feature' || typeof nativeId !== 'string' || !NATIVE_ID.test(nativeId)
                || row.properties?.FID !== nativeId || !validateGeometry(row.geometry)) {
                throw upstreamError('DGI returned invalid parcel identity or polygon geometry.');
            }
            const extent = geometryBbox(row);
            if (extent[2] < bbox[0] || extent[0] > bbox[2] || extent[3] < bbox[1] || extent[1] > bbox[3]) {
                throw upstreamError('DGI returned a polygon outside the requested bounds.');
            }
            if (found.has(nativeId)) throw upstreamError('DGI repeated a native parcel ID.');
            // Only FID survives parsing; no provider labels, flags or other attributes are retained.
            found.set(nativeId, canonicalParcelFeature(descriptor,
                { geometry: row.geometry, properties: { FID: nativeId } }, nativeId));
        }
        return result([...found.values()], { apparentCeilingReached: payload.features.length === 1000 });
    }

    function queryBounds(bbox) { return readBounds(bbox, AbortSignal.timeout(45000)); }

    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80 || ids.some(value => typeof value !== 'string'
            || !value.startsWith(idPrefix) || !NATIVE_ID.test(value.slice(idPrefix.length)))) {
            throw new HttpError(400, 'Provide between 1 and 80 canonical DGI parcel IDs.');
        }
        const wanted = [...new Set(ids)], found = new Map(), signal = AbortSignal.timeout(45000);
        // No in-memory ID/geometry index is needed, including after a process restart. The declared
        // windows bound this adapter's support; they are neither a commune boundary nor all-city scope.
        for (const bbox of lookupBounds) {
            const response = await readBounds(bbox, signal);
            for (const parcel of response.features) if (wanted.includes(parcel.id)) {
                const previous = found.get(parcel.id);
                if (previous && JSON.stringify(previous.geometry) !== JSON.stringify(parcel.geometry)) {
                    throw upstreamError('DGI returned conflicting geometry for a native ID.');
                }
                found.set(parcel.id, parcel);
            }
        }
        const complete = wanted.every(parcelId => found.has(parcelId));
        // All requested full polygons can be returned exactly even though area enumeration is
        // unverified. A missing row is unresolved, never an assertion of authoritative absence.
        return result([...found.values()], { complete, absentIds: [],
            completenessReason: complete ? 'Every requested native ID was read from the live source.'
                : 'Some requested IDs were not observed; provider absence/completeness is unverified.' });
    }

    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide a valid WGS84 Polygon or MultiPolygon.');
        const footprint = geoFeature(geometry);
        const response = await queryBounds(geometryBbox(footprint));
        return { ...response, features: response.features.filter(parcel => booleanIntersects(parcel, footprint)) };
    }
    return Object.freeze({ queryBounds, queryIds, queryGeometry });
}
