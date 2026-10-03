// Shared WGS84 validation, errors and canonical parcel features for every live source adapter.
import { HttpError, wgs84BboxAreaKm2 } from '../utils/helpers.js';

export function upstreamError(message, status = 502) {
    const error = new Error(message);
    error.status = status;
    error.code = 'parcel-source-unavailable';
    return error;
}

export function validateBounds(bbox, maxKm2 = 25, limits = {}) {
    if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(value => typeof value === 'number' && Number.isFinite(value))) {
        throw new HttpError(400, 'Expected a finite WGS84 bbox: west,south,east,north.');
    }
    const [w, s, e, n] = bbox;
    if (w < -180 || e > 180 || s < -90 || n > 90 || w >= e || s >= n) {
        throw new HttpError(400, 'Invalid WGS84 bbox.');
    }
    if (wgs84BboxAreaKm2(w, s, e, n) > maxKm2) throw new HttpError(400, 'Parcel query area is too large; request viewport cells.');
    const widthM = (e - w) * 111320 * Math.cos((s + n) / 2 * Math.PI / 180);
    const heightM = (n - s) * 111320;
    if ((limits.maxBboxWidthM && widthM > limits.maxBboxWidthM)
        || (limits.maxBboxHeightM && heightM > limits.maxBboxHeightM)) {
        throw new HttpError(400, 'Parcel query dimensions exceed the provider limit; request smaller viewport cells.');
    }
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
    const number = props[descriptor.parcelNumberField];
    const displayNumber = typeof number === 'string' && number.trim() ? number
        : Number.isSafeInteger(number) && number >= 0 ? String(number) : String(nativeId);
    return {
        type: 'Feature', id: parcelId, geometry: feature.geometry,
        properties: {
            parcelId, id: parcelId, sourceId: descriptor.id, sourceParcelId: String(nativeId),
            parcelNumber: displayNumber,
            // A source can span cities; configured entry names are not cadastral municipality facts.
            cadMunicipalityName: null,
            ownershipType: 'unknown',
            sourceProperties: Object.fromEntries(descriptor.outFields.filter(field => field in props).map(field => [field, props[field]]))
        }
    };
}

// The same fixed attribute expressions work in ArcGIS SQL, OGC CQL2 and Socrata SoQL.
export function createParcelAttributeFilter(descriptor) {
    const entries = Object.entries(descriptor.attributeFilters || {}).map(([field, value]) =>
        [field, Array.isArray(value) ? value : [value], false]);
    entries.push(...Object.entries(descriptor.attributeExclusions || {}).map(([field, value]) =>
        [field, Array.isArray(value) ? value : [value], true]));
    if (entries.some(([field, values]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field) || !descriptor.outFields.includes(field)
        || !values.length || values.length > 80 || values.some(value => typeof value !== 'boolean' && (typeof value !== 'string' || !value || value.length > 256)))) {
        throw new Error('Invalid parcel attribute filter.');
    }
    const where = entries.map(([field, values, exclude]) => {
        const literals = values.map(value => typeof value === 'boolean' ? String(value) : `'${value.replaceAll("'", "''")}'`);
        return literals.length === 1 ? `${field} ${exclude ? '<>' : '='} ${literals[0]}`
            : `${field} ${exclude ? 'NOT IN' : 'IN'} (${literals.join(',')})`;
    }).join(' AND ');
    // SQL comparisons exclude NULL; enforce the same boundary if a provider ignores its filter.
    return { where, matches: props => entries.every(([field, values, exclude]) =>
        exclude ? props[field] !== null && props[field] !== undefined && !values.includes(props[field])
            : values.includes(props[field])) };
}
