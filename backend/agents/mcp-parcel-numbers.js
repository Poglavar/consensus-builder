// Resolve the same label shown on the map, within an explicit source and viewport.
import { createRequire } from 'node:module';
import { appTurf as turf } from './mcp-geometry.js';
const require = createRequire(import.meta.url);
const { cadastralParts } = require('../../frontend/js/parcels/live-fabric.js');
const { getParcelDisplayNumberFromFeature } = require('../../frontend/js/proposals/parcel-id.js');
const normalized = value => typeof value === 'string' ? value.normalize('NFKC').trim().toLowerCase() : '';
const fail = (code, message, action) => Object.assign(new Error(message), { code, next: { action } });
const pointValid = point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)
    && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 85;

export async function resolveParcelNumber({ parcelNumber, city, parcelSourceId, visibleParcels, visibleParcelsTruncated, bbox, read }) {
    const query = normalized(parcelNumber);
    if (!query || query.length > 250) throw fail('parcel-number-required', 'Supply the exact displayed parcel number.', 'Read a parcel number from the map or supply its full source ID.');
    let candidates;
    if (visibleParcels !== undefined) {
        if (!Array.isArray(visibleParcels) || visibleParcels.length > 500 || visibleParcelsTruncated === true)
            throw fail('parcel-label-coverage-incomplete', 'The visible parcel label list is incomplete.', 'Zoom in so all visible parcel labels can be resolved, or supply a full parcel ID.');
        candidates = visibleParcels;
        if (candidates.some(item => !item || typeof item.parcelId !== 'string' || !item.parcelId.trim()
            || item.parcelId.length > 250 || typeof item.label !== 'string' || item.label.length > 250 || !pointValid(item.point)))
            throw fail('invalid-parcel-labels', 'The visible parcel labels are invalid.', 'Refresh the map before selecting a displayed number.');
    } else {
        if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite)
            || bbox[0] < -180 || bbox[2] > 180 || bbox[1] < -85 || bbox[3] > 85
            || bbox[2] <= bbox[0] || bbox[3] <= bbox[1] || bbox[2] - bbox[0] > 0.03 || bbox[3] - bbox[1] > 0.03)
            throw fail('parcel-number-bounds-required', 'Parcel number lookup needs a small explicit viewport.', 'Supply a bbox no larger than 0.03 degrees, or supply a full parcel ID.');
        const result = await read.parcels({ city, parcelSourceId, geometry: turf.bboxPolygon(bbox).geometry });
        if (result.complete !== true || result.truncated || !Array.isArray(result.features))
            throw fail('parcel-coverage-incomplete', 'Parcel number lookup needs complete source coverage.', 'Retry when the source is available or zoom in.');
        candidates = result.features.flatMap(cadastralParts).map(feature => ({
            parcelId: String(feature.properties?.parcelId ?? feature.id ?? ''),
            label: getParcelDisplayNumberFromFeature(feature), point: turf.pointOnFeature(feature).geometry.coordinates
        }));
    }
    const matches = [...new Map(candidates.filter(item => normalized(item.label) === query || normalized(item.parcelId) === query)
        .map(item => [item.parcelId, item])).values()];
    if (!matches.length) throw fail('parcel-number-not-found', 'That parcel number is not in the current lookup area.', 'Show parcel ids, move or zoom the map to that parcel, or supply its full source ID.');
    if (matches.length !== 1) throw Object.assign(fail('parcel-number-ambiguous', 'More than one parcel has that displayed number.', 'Ask which parcel is intended; zoom to one, select it manually, or supply its full source ID.'),
        { constraints: { matches: matches.slice(0, 8).map(({ parcelId, label, point }) => ({ parcelId, label, point })) } });
    return { ...matches[0], point: [...matches[0].point] };
}
