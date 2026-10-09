// Strict straight-ring Esri JSON reader. Coordinates and all native rings are retained;
// curves, ambiguous holes and unsupported coordinate systems remain unavailable.
import { booleanPointInPolygon, lineIntersect, lineString, point, polygon } from '@turf/turf';
import { upstreamError, validateGeometry } from './source-contract.js';

const wgs84 = sr => sr && (sr.wkid === 4326 || sr.latestWkid === 4326)
    && [sr.wkid, sr.latestWkid].every(value => value === undefined || value === 4326);

function linearPolygon(geometry, collectionCrs) {
    if (!geometry || geometry.curveRings !== undefined || geometry.hasZ || geometry.hasM
        || !wgs84(geometry.spatialReference || collectionCrs)
        || !Array.isArray(geometry.rings) || !geometry.rings.length) {
        throw upstreamError('Unsupported Esri parcel polygon representation.');
    }
    const shells = [], holes = [];
    for (const sourceRing of geometry.rings) {
        if (!validateGeometry({ type: 'Polygon', coordinates: [sourceRing] })
            || sourceRing.some(p => p.length !== 2)) {
            throw upstreamError('Invalid Esri parcel polygon ring.');
        }
        // Translate the shoelace origin to avoid cancellation at small geographic parcels.
        const [x, y] = sourceRing[0];
        let signedArea = 0;
        for (let i = 1; i < sourceRing.length; i++) {
            signedArea += (sourceRing[i - 1][0] - x) * (sourceRing[i][1] - y)
                - (sourceRing[i][0] - x) * (sourceRing[i - 1][1] - y);
        }
        if (!Number.isFinite(signedArea) || signedArea === 0) {
            throw upstreamError('Esri parcel polygon ring has no signed area.');
        }
        const ring = sourceRing.map(p => [...p]);
        // Esri's documented convention: clockwise exteriors, counterclockwise holes.
        if (signedArea < 0) shells.push([ring]);
        else holes.push(ring);
    }
    if (!shells.length) throw upstreamError('Esri parcel polygon has no exterior ring.');
    for (const hole of holes) {
        const containers = shells.filter(([shell]) => {
            const exterior = polygon([shell]);
            return hole.slice(0, -1).every(p => booleanPointInPolygon(point(p), exterior, { ignoreBoundary: true }))
                && lineIntersect(lineString(hole), lineString(shell)).features.length === 0;
        });
        if (containers.length !== 1) throw upstreamError('Esri parcel polygon has an ambiguous or unsupported hole.');
        containers[0].push(hole);
    }
    return shells.length === 1 ? { type: 'Polygon', coordinates: shells[0] }
        : { type: 'MultiPolygon', coordinates: shells };
}

export function parseEsriParcelCollection(payload) {
    if (!payload || payload.geometryType !== 'esriGeometryPolygon' || payload.hasZ || payload.hasM
        || !wgs84(payload.spatialReference) || !Array.isArray(payload.features)) {
        throw upstreamError('Invalid Esri parcel polygon collection.');
    }
    return { type: 'FeatureCollection', exceededTransferLimit: payload.exceededTransferLimit,
        features: payload.features.map(feature => {
            if (!feature?.attributes || typeof feature.attributes !== 'object' || Array.isArray(feature.attributes)) {
                throw upstreamError('Esri parcel feature has no attribute object.');
            }
            return { type: 'Feature', properties: feature.attributes,
                geometry: linearPolygon(feature.geometry, payload.spatialReference) };
        }) };
}
