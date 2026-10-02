// Shared WGS84 validation, errors and canonical parcel features for every live source adapter.
import { HttpError, wgs84BboxAreaKm2 } from '../utils/helpers.js';

export function upstreamError(message, status = 502) {
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

export function validateGeometry(geometry) {
    if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type) || !Array.isArray(geometry.coordinates)) return false;
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    return polygons.length > 0 && polygons.every(polygon => Array.isArray(polygon) && polygon.length > 0 && polygon.every(ring =>
        Array.isArray(ring) && ring.length >= 4 && ring.every(point => Array.isArray(point)
            && point.length >= 2 && typeof point[0] === 'number' && typeof point[1] === 'number'
            && Number.isFinite(point[0]) && Number.isFinite(point[1])
            && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90)
        && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]));
}

export function canonicalParcelFeature(descriptor, feature, nativeId) {
    const props = feature.properties || {};
    const parcelId = `${descriptor.idPrefix}${nativeId}`;
    return {
        type: 'Feature', id: parcelId, geometry: feature.geometry,
        properties: {
            parcelId, id: parcelId, sourceId: descriptor.id, sourceParcelId: String(nativeId),
            parcelNumber: descriptor.parcelNumberField && typeof props[descriptor.parcelNumberField] === 'string'
                && props[descriptor.parcelNumberField].trim() ? props[descriptor.parcelNumberField] : String(nativeId),
            cadMunicipalityName: descriptor.cityId || null,
            ownershipType: 'unknown',
            sourceProperties: Object.fromEntries(descriptor.outFields.filter(field => field in props).map(field => [field, props[field]]))
        }
    };
}
