// A source zone cut to the requested box for display. turf.bboxClip leaves the parts and holes that
// fall outside the box as empty or degenerate rings, and one such ring made the whole zone fail
// geometry validation, so the map drew nothing for it. Those rings and parts are dropped here; a
// zone with nothing left inside the box has no display geometry (null).
import * as turf from '@turf/turf';

const closedRing = ring => ring.length >= 4;

export function clipToBounds(feature, bbox) {
    const clipped = turf.bboxClip(feature, bbox).geometry;
    const polygons = (clipped.type === 'Polygon' ? [clipped.coordinates] : clipped.coordinates)
        // A part whose outline left the box is gone, holes and all; a hole that left it is dropped.
        .filter(polygon => polygon.length && closedRing(polygon[0]))
        .map(([outline, ...holes]) => [outline, ...holes.filter(closedRing)]);
    if (!polygons.length) return null;
    return polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0] } : { type: 'MultiPolygon', coordinates: polygons };
}
