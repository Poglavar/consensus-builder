// Adapts a fixed ArcGIS parcel layer to complete, canonical WGS84 parcel collections.
import { bbox as geometryBbox, booleanIntersects, feature as geoFeature } from '@turf/turf';
import { HttpError, wgs84BboxAreaKm2 } from '../utils/helpers.js';

function upstreamError(message, status = 502) {
    const error = new Error(message);
    error.status = status;
    error.code = 'parcel-source-unavailable';
    return error;
}

export function validateBounds(bbox, maxKm2 = 25) {
    if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(value => typeof value === 'number' && Number.isFinite(value))) {
        throw new HttpError(400, 'Expected a finite WGS84 bbox: west,south,east,north.');
    }
    const [w, s, e, n] = bbox;
    if (w < -180 || e > 180 || s < -90 || n > 90 || w >= e || s >= n) {
        throw new HttpError(400, 'Invalid WGS84 bbox.');
    }
    if (wgs84BboxAreaKm2(w, s, e, n) > maxKm2) throw new HttpError(400, 'Parcel query area is too large; request viewport cells.');
    return bbox;
}

function validateGeometry(geometry) {
    if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type) || !Array.isArray(geometry.coordinates)) return false;
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    return polygons.length > 0 && polygons.every(polygon => polygon.length > 0 && polygon.every(ring =>
        Array.isArray(ring) && ring.length >= 4 && ring.every(point => Array.isArray(point)
            && point.length >= 2 && typeof point[0] === 'number' && typeof point[1] === 'number'
            && Number.isFinite(point[0]) && Number.isFinite(point[1])
            && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90)
        && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]));
}

export function createArcgisParcelSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    const { id, endpoint, idField, objectIdField, idPrefix, outFields } = descriptor;
    const pageSize = descriptor.pageSize || 2000;
    const maxFeatures = descriptor.maxFeatures || 10000;
    const maxBboxKm2 = descriptor.maxBboxKm2 || 25;
    const idType = descriptor.idType || 'integer';
    const idPattern = descriptor.idPattern ? new RegExp(descriptor.idPattern) : null;
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
    if (!id || !idPrefix || !identifier.test(idField) || !identifier.test(objectIdField)
        || !['integer', 'string'].includes(idType)
        || new URL(endpoint).protocol !== 'https:') throw new Error('Invalid ArcGIS parcel source descriptor.');

    function validNativeId(value) {
        const text = String(value ?? '');
        if (idType === 'string') return typeof value === 'string' && text.length > 0
            && text.length <= 256 && (!idPattern || idPattern.test(text));
        return /^(0|[1-9][0-9]*)$/.test(text) && Number.isSafeInteger(Number(text));
    }

    async function query(params) {
        const byId = new Map();
        const seenObjects = new Set();
        let offset = 0;
        for (;;) {
            const search = new URLSearchParams({
                where: '1=1', outFields: outFields.join(','), returnGeometry: 'true',
                outSR: '4326', f: 'geojson', orderByFields: objectIdField,
                resultRecordCount: String(pageSize), resultOffset: String(offset), ...params
            });
            const signal = AbortSignal.timeout(15000);
            let payload;
            try {
                const response = await fetchImpl(`${endpoint}/query?${search}`, { signal, headers: { Accept: 'application/geo+json, application/json' } });
                if (!response.ok) throw upstreamError(`Parcel provider returned HTTP ${response.status}.`);
                payload = await response.json();
            } catch (error) {
                if (signal.aborted || error.name === 'TimeoutError' || error.name === 'AbortError') throw upstreamError('Parcel provider timed out.', 504);
                if (error.status) throw error;
                throw upstreamError(`Parcel provider is unavailable: ${error.message}`);
            }
            if (payload.error) throw upstreamError(`ArcGIS parcel query failed: ${payload.error.message || payload.error.code}`);
            if (payload.type !== 'FeatureCollection' || !Array.isArray(payload.features)) throw upstreamError('Parcel provider returned an invalid FeatureCollection.');
            const page = payload.features;
            if (offset + page.length > maxFeatures) throw upstreamError('Parcel provider query exceeds the parcel limit; use a smaller area.');
            for (const feature of page) {
                const props = feature.properties || {};
                const nativeId = props[idField];
                if (!validNativeId(nativeId)) {
                    throw upstreamError('Parcel provider returned a missing or invalid native parcel ID.');
                }
                if (!validateGeometry(feature.geometry)) throw upstreamError('Parcel provider returned invalid polygon geometry.');
                const objectId = props[objectIdField];
                if (objectId === undefined || objectId === null || seenObjects.has(String(objectId))) {
                    throw upstreamError('Parcel provider pagination repeated or omitted an object ID.');
                }
                seenObjects.add(String(objectId));
                const parcelId = `${idPrefix}${nativeId}`;
                const canonical = {
                    type: 'Feature', id: parcelId, geometry: feature.geometry,
                    properties: {
                        parcelId, id: parcelId, sourceId: id, sourceParcelId: String(nativeId),
                        parcelNumber: String(nativeId), cadMunicipalityName: descriptor.cityId || null,
                        ownershipType: 'unknown',
                        sourceProperties: Object.fromEntries(outFields.filter(field => field in props).map(field => [field, props[field]]))
                    }
                };
                const previous = byId.get(parcelId);
                if (previous && JSON.stringify(previous.geometry) !== JSON.stringify(canonical.geometry)) {
                    throw upstreamError('Parcel provider returned conflicting geometry for one parcel ID.');
                }
                byId.set(parcelId, canonical);
            }
            // Some ArcGIS GeoJSON services omit the flag even for a truncated full page.
            const hasMore = payload.exceededTransferLimit === true
                || (typeof payload.exceededTransferLimit !== 'boolean' && page.length === pageSize);
            if (!hasMore) break;
            if (!page.length || offset + page.length >= maxFeatures) throw upstreamError('Parcel provider returned incomplete pagination.');
            offset += page.length;
        }
        return { type: 'FeatureCollection', features: [...byId.values()], complete: true, sourceId: id, returnsWGS84: true };
    }

    function queryBounds(bbox) {
        validateBounds(bbox, maxBboxKm2);
        return query({ geometry: bbox.join(','), geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects' });
    }

    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80) throw new HttpError(400, 'Provide between 1 and 80 parcel IDs.');
        const unique = [...new Set(ids)];
        const native = unique.map(value => {
            if (typeof value !== 'string' || !value.startsWith(idPrefix)) throw new HttpError(400, 'Parcel ID belongs to a different source.');
            const tail = value.slice(idPrefix.length);
            if (!validNativeId(tail)) throw new HttpError(400, 'Invalid parcel ID.');
            // Native string keys must retain leading zeroes and use SQL string literals.
            return idType === 'string' ? `'${tail.replaceAll("'", "''")}'` : tail;
        });
        const result = await query({ where: `${idField} IN (${native.join(',')})` });
        if (result.features.some(feature => !unique.includes(feature.properties.parcelId))) throw upstreamError('Parcel ID query returned unexpected parcels.');
        const present = new Set(result.features.map(feature => feature.properties.parcelId));
        return { ...result, absentIds: unique.filter(value => !present.has(value)) };
    }

    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide a valid WGS84 Polygon or MultiPolygon.');
        const footprint = geoFeature(geometry);
        const result = await queryBounds(geometryBbox(footprint));
        return { ...result, features: result.features.filter(parcel => booleanIntersects(parcel, footprint)) };
    }

    return Object.freeze({ queryBounds, queryIds, queryGeometry });
}
