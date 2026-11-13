// Which cadastral parcels are streets, judged from OSM road lines: a parcel is a road when the
// corridors of the OSM ways crossing it TOGETHER cover more than half of it. A wide street parcel
// usually carries several ways (carriageway pieces, footways, a tram line), none of which covers
// half of it alone. Pure geometry with turf passed in: road-detection.js marks the parcels, and
// backend/test/osm-road-coverage.test.js checks the rule headlessly.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__osmRoadCoverage = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const ROAD_HALF_WIDTH_M = 3;   // an OSM line stands for a corridor this far to each side
    const PARCEL_MARGIN_M = 2;     // a parcel drawn a little off the line still counts as under it
    const ROAD_SHARE = 0.5;        // more than this share of the parcel under road corridors = a road

    function bboxesOverlap(a, b) {
        return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
    }

    // The corridor of each OSM road line, with its bbox for the prefilter. A feature without
    // geometry is left out.
    function roadCorridors(roadFeatures, turf) {
        const corridors = [];
        (roadFeatures || []).forEach(road => {
            if (!road?.geometry?.coordinates) return;
            const polygon = turf.buffer(road, ROAD_HALF_WIDTH_M, { units: 'meters' });
            if (polygon?.geometry) corridors.push({ polygon, bbox: turf.bbox(polygon) });
        });
        return corridors;
    }

    // True when the corridors together cover more than ROAD_SHARE of the parcel. `onClipError`
    // hears each intersection or union turf could not compute; that piece then counts as uncovered.
    function coversAsRoad(parcel, corridors, turf, onClipError = null) {
        const parcelArea = turf.area(parcel);
        if (!(parcelArea > 0)) return false;
        const reach = turf.buffer(parcel, PARCEL_MARGIN_M, { units: 'meters' });
        if (!reach?.geometry) return false;
        const reachBbox = turf.bbox(reach);
        const pieces = [];
        for (const corridor of corridors) {
            if (!bboxesOverlap(reachBbox, corridor.bbox)) continue;
            let piece = null;
            try {
                piece = turf.intersect(reach, corridor.polygon);
            } catch (error) {
                if (onClipError) onClipError('intersect', error, [reach, corridor.polygon]);
            }
            if (!piece) continue;
            const area = turf.area(piece);
            // One way over most of the parcel settles it without merging anything.
            if (area / parcelArea > ROAD_SHARE) return true;
            pieces.push({ piece, area });
        }
        // Overlapping corridors (a footway beside its carriageway) count once: the share is the
        // area of their union, which the plain sum only bounds from above.
        if (pieces.reduce((sum, p) => sum + p.area, 0) / parcelArea <= ROAD_SHARE) return false;
        let covered = pieces[0].piece;
        for (const { piece } of pieces.slice(1)) {
            try {
                covered = turf.union(covered, piece) || covered;
            } catch (error) {
                if (onClipError) onClipError('union', error, [covered, piece]);
            }
        }
        return turf.area(covered) / parcelArea > ROAD_SHARE;
    }

    return { ROAD_HALF_WIDTH_M, PARCEL_MARGIN_M, ROAD_SHARE, roadCorridors, coversAsRoad };
});
