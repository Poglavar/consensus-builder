// Reproducible application references for source polygons that have no published parcel key.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { HttpError } from '../utils/helpers.js';
import { validateGeometry, upstreamError } from './source-contract.js';

const require = createRequire(import.meta.url);
const { canonicalSiteCoordinates, COORDINATE_SCALE } = require('../../frontend/js/proposals/site-hash.js');
export const GEOMETRY_IDENTITY_KIND = 'geometry-sha256-v1';

export function geometryParcelFeature(descriptor, feature) {
    if (feature?.type !== 'Feature' || !validateGeometry(feature.geometry)) {
        throw upstreamError('Outline provider returned invalid polygon geometry.');
    }
    let coordinates;
    try { coordinates = canonicalSiteCoordinates(feature.geometry); }
    catch { throw upstreamError('Outline provider returned a polygon without usable area.'); }
    const original = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    // Site encoding can omit collapsed rings. A source outline must keep every component and hole.
    if (coordinates.length !== original.length
        || coordinates.reduce((sum, polygon) => sum + polygon.length, 0) !== original.reduce((sum, polygon) => sum + polygon.length, 0)) {
        throw upstreamError('Outline geometry collapses at the identity precision.');
    }
    const encoded = JSON.stringify({ coordinates, type: 'MultiPolygon' });
    const hash = createHash('sha256').update(`${descriptor.id}\n${GEOMETRY_IDENTITY_KIND}\n${encoded}`).digest('hex');
    const [longitude, latitude] = coordinates[0][0][0];
    // A deterministic vertex locates a fresh bounded read after a restart; the hash checks its shape.
    const parcelId = `${descriptor.idPrefix}g1~${longitude}~${latitude}~${hash}`;
    return {
        type: 'Feature', id: parcelId,
        geometry: { type: 'MultiPolygon', coordinates: coordinates.map(polygon => polygon.map(ring =>
            ring.map(point => point.map(value => value / COORDINATE_SCALE)))) },
        properties: {
            id: parcelId, parcelId, sourceId: descriptor.id,
            sourceParcelId: null, parcelNumber: null,
            parcelIdentityKind: GEOMETRY_IDENTITY_KIND,
            geometryDisplayId: `G1-${hash.slice(0, 12)}`,
            sourceGeometryHash: hash,
            cadMunicipalityName: null, ownershipType: 'unknown', sourceProperties: {}
        }
    };
}

export function parseGeometryParcelId(descriptor, value) {
    if (typeof value !== 'string' || !value.startsWith(descriptor.idPrefix)) {
        throw new HttpError(400, 'Parcel ID belongs to a different source.');
    }
    const parts = value.slice(descriptor.idPrefix.length).split('~');
    const longitude = Number(parts[1]), latitude = Number(parts[2]);
    if (parts.length !== 4 || parts[0] !== 'g1' || !/^[0-9a-f]{64}$/.test(parts[3])
        || !Number.isSafeInteger(longitude) || !Number.isSafeInteger(latitude)
        || String(longitude) !== parts[1] || String(latitude) !== parts[2]
        || Math.abs(longitude) > 180 * COORDINATE_SCALE || Math.abs(latitude) > 90 * COORDINATE_SCALE) {
        throw new HttpError(400, 'Invalid geometry-derived parcel ID.');
    }
    return { longitude, latitude, hash: parts[3] };
}

export function geometryLookupBounds(locator, cellSize) {
    const units = Math.round(cellSize * COORDINATE_SCALE);
    const x = Math.floor(locator.longitude / units), y = Math.floor(locator.latitude / units);
    // Two encoding units include the original vertex even when rounding crosses a cell boundary.
    return [Math.max(-180, (x * units - 2) / COORDINATE_SCALE),
        Math.max(-90, (y * units - 2) / COORDINATE_SCALE),
        Math.min(180, ((x + 1) * units + 2) / COORDINATE_SCALE),
        Math.min(90, ((y + 1) * units + 2) / COORDINATE_SCALE)];
}
