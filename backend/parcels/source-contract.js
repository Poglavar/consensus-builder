// Shared WGS84 validation, errors and canonical parcel features for every live source adapter.
import { HttpError, wgs84BboxAreaKm2 } from '../utils/helpers.js';

export function upstreamError(message, status = 502, code = 'parcel-source-unavailable') {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    return error;
}

const MAX_RETRY_AFTER_SECONDS = 60 * 60;

function retryAfterSeconds(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return undefined;
    const text = String(value).trim();
    if (!text) return undefined;
    let seconds;
    if (/^\d+$/.test(text)) seconds = Number(text);
    else if (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) {
        const at = Date.parse(text);
        if (!Number.isFinite(at)) return undefined;
        seconds = Math.max(0, Math.ceil((at - Date.now()) / 1000));
    } else return undefined;
    return Number.isFinite(seconds) ? Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(0, Math.ceil(seconds))) : undefined;
}

// Translate upstream HTTP/service errors to stable gateway metadata without copying
// provider response text, URLs, credentials, or query parameters into client errors.
export function providerHttpError(responseOrStatus, retryAfterOverride) {
    const status = typeof responseOrStatus === 'number'
        ? responseOrStatus
        : Number(responseOrStatus?.status ?? responseOrStatus?.code);
    const validStatus = Number.isSafeInteger(status) && status >= 100 && status <= 599;
    const upstreamStatus = validStatus ? status : undefined;
    let code = 'parcel-source-unavailable';
    let message = 'Parcel provider is unavailable.';
    if ([401, 403, 498, 499].includes(status)) {
        code = 'parcel-source-blocked';
        message = 'Parcel provider access is blocked.';
    } else if (status === 429) {
        code = 'parcel-source-rate-limited';
        message = 'Parcel provider is rate limited.';
    }
    const error = upstreamError(message, 502, code);
    if (upstreamStatus !== undefined) {
        error.upstreamStatus = upstreamStatus;
        error.message = `${message.replace(/\.$/, '')} (HTTP ${upstreamStatus}).`;
    }
    if (status === 429) {
        let retry = retryAfterOverride;
        if (retry === undefined && responseOrStatus && typeof responseOrStatus === 'object') {
            try { retry = responseOrStatus.headers?.get?.('retry-after'); } catch { /* Ignore malformed provider headers. */ }
        }
        const seconds = retryAfterSeconds(retry);
        if (seconds !== undefined) error.retryAfterSeconds = seconds;
    }
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
