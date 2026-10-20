// How a junction and the strips of its arms share the 2D paint (road-editor.md decision 1). The
// junction's carriageway and footway corners are painted ONCE, at the same opacity as every lane
// strip, and each arm's strips are clipped to what the junction leaves them — so a junction reads
// as the same asphalt as the lanes beside it. Before this, the junction was an opaque patch laid
// over strips that ran through to the node (the only way to hide the crossing road's strips under
// the box), which made every junction a darker shade than the lanes. Planar booleans by turf on
// Leaflet ring arrays ([{ lat, lng }, …]) in and out; the results are affine-invariant, so working
// in degrees gives exactly the partition metres would. No DOM, no Leaflet.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__corridorJunctionPaint = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
    'use strict';

    function turfLib() {
        if (global && global.turf && typeof global.turf.difference === 'function') return global.turf;
        if (typeof require === 'function') {
            try { return require('@turf/turf'); } catch (_) { /* not resolvable from frontend/js */ }
            try { return require(require.resolve('@turf/turf', { paths: [process.cwd()] })); } catch (_) { /* fall through */ }
        }
        throw new Error('corridor-junction-paint: turf is not available');
    }

    // A clip that fails here only changes how a junction is painted: it is reported and counted in
    // clipHealth() (parcel-arrangement.js), and the caller paints the old look.
    function reportClip(operation, error, context, operands) {
        const clips = (global && global.__parcelArrangement)
            || (typeof require === 'function' ? require('./proposals/parcel-arrangement.js') : null);
        if (!clips || typeof clips.reportClipFailure !== 'function') throw error;
        return clips.reportClipFailure(operation, error, context, operands);
    }

    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const toCoordinate = point => (Array.isArray(point) ? [point[1], point[0]] : [point.lng, point.lat]);
    const toLatLng = ([lng, lat]) => ({ lat, lng });

    // A Leaflet ring as a closed GeoJSON polygon feature, or null for anything with no area.
    function ringFeature(ring) {
        if (!Array.isArray(ring) || ring.length < 3) return null;
        const coordinates = ring.map(toCoordinate);
        if (!coordinates.every(([lng, lat]) => finite(lng) && finite(lat))) return null;
        const first = coordinates[0];
        const last = coordinates[coordinates.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) coordinates.push([first[0], first[1]]);
        if (coordinates.length < 4) return null;
        return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [coordinates] } };
    }

    function bboxOf(coordinates) {
        const box = [Infinity, Infinity, -Infinity, -Infinity];
        const walk = node => {
            if (finite(node[0]) && finite(node[1]) && !Array.isArray(node[0])) {
                box[0] = Math.min(box[0], node[0]); box[1] = Math.min(box[1], node[1]);
                box[2] = Math.max(box[2], node[0]); box[3] = Math.max(box[3], node[1]);
            } else node.forEach(walk);
        };
        walk(coordinates);
        return box;
    }
    const bboxesMeet = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
    // Shoelace area of a closed GeoJSON ring, in square degrees.
    const ringAreaDeg = ring => Math.abs(ring.reduce((sum, [x, y], index) => {
        const [nx, ny] = ring[(index + 1) % ring.length];
        return sum + x * ny - nx * y;
    }, 0) / 2);
    // Below this (about a square centimetre at mid latitudes) a ring is a boolean's leftover — a
    // degenerate hole, or a sliver between two pieces — not something to paint: every painted
    // polygon carries a hairline stroke, so a sliver would draw as a line.
    const NEGLIGIBLE_DEG2 = 1e-14;

    // Rings united into one geometry (Polygon or MultiPolygon), or null when none has area. A ring
    // turf cannot take is left out rather than failing the whole union: that one piece then stays
    // double-painted, which is the old look, not a missing road.
    function unionOfRings(rings) {
        const turf = turfLib();
        let united = null;
        (rings || []).forEach(ring => {
            const feature = ringFeature(ring);
            if (!feature) return;
            try {
                united = united ? turf.union(united, feature) : feature;
            } catch (error) {
                // Measured on the real Šibenik plan: "Maximum call stack size exceeded" here. The
                // piece is painted on its own (the old double-painted look), reported and counted.
                reportClip('union', error, { site: 'corridor-junction-paint.unionOfRings' }, [united, feature]);
            }
        });
        return united && united.geometry ? united.geometry : null;
    }

    // A GeoJSON Polygon/MultiPolygon as the list of Leaflet polygons it draws as: each an array of
    // rings (the outer ring first, holes after), which L.polygon takes as it is.
    function leafletPolygons(geometry) {
        if (!geometry) return [];
        const polygons = geometry.type === 'MultiPolygon' ? geometry.coordinates
            : geometry.type === 'Polygon' ? [geometry.coordinates] : [];
        return polygons
            .map(rings => rings.filter(ring => ringAreaDeg(ring) > NEGLIGIBLE_DEG2).map(ring => ring.slice(0, -1).map(toLatLng)).filter(ring => ring.length >= 3))
            .filter(rings => rings.length && ringAreaDeg(polygons[0] && rings[0] ? rings[0].map(p => [p.lng, p.lat]) : []) > NEGLIGIBLE_DEG2);
    }

    // The paint of one junction treatment (corridor-profile.js junctionTreatmentFor), found once per
    // treatment object: `surface` is the carriageway united so overlapping arm boxes paint once,
    // `coverage` is everything the junction paints (carriageway and footway corners) — the area no
    // arm strip may paint under.
    const paintByTreatment = new WeakMap();
    function paintOf(treatment) {
        if (!treatment || typeof treatment !== 'object') return null;
        if (paintByTreatment.has(treatment)) return paintByTreatment.get(treatment);
        const surfaceRings = Array.isArray(treatment.surfacePolygons) ? treatment.surfacePolygons : [];
        const cornerRings = (Array.isArray(treatment.cornerPolygons) ? treatment.cornerPolygons : [])
            .map(corner => corner && corner.polygon).filter(Boolean);
        const surface = unionOfRings(surfaceRings);
        const coverage = cornerRings.length ? unionOfRings([...surfaceRings, ...cornerRings]) : surface;
        const paint = {
            surface,
            surfacePolygons: leafletPolygons(surface),
            coverage,
            bbox: coverage ? bboxOf(coverage.coordinates) : null
        };
        paintByTreatment.set(treatment, paint);
        return paint;
    }

    // The carriageway of one junction as Leaflet polygons, painted once.
    function junctionSurfacePolygons(treatment) {
        const paint = paintOf(treatment);
        return paint ? paint.surfacePolygons : [];
    }

    // `geometry` (GeoJSON Polygon/MultiPolygon) less what the junctions paint; null when nothing
    // is left. A difference turf refuses leaves the geometry as it was for that junction.
    function clipGeometry(geometry, treatments) {
        if (!geometry) return null;
        const covers = (treatments || []).map(paintOf).filter(paint => paint && paint.coverage);
        if (!covers.length) return geometry;
        const turf = turfLib();
        const box = bboxOf(geometry.coordinates);
        let feature = { type: 'Feature', properties: {}, geometry };
        for (const cover of covers) {
            if (!bboxesMeet(box, cover.bbox)) continue;
            try {
                const left = turf.difference(feature, { type: 'Feature', properties: {}, geometry: cover.coverage });
                if (!left || !left.geometry) return null;
                feature = left;
            } catch (error) {
                // The strip is painted whole under that junction; reported and counted.
                reportClip('difference', error, { site: 'corridor-junction-paint.clipGeometry' }, [feature, cover.coverage]);
            }
        }
        return feature.geometry;
    }

    // Strips (corridor-profile.js buildCorridorStrips: { type, …, polygons: [ring] }) with every
    // ring clipped to outside the junctions' paint. A ring no junction touches is returned as the
    // same object; a clipped one becomes one or more Leaflet polygons (arrays of rings), which is
    // also what L.polygon takes. A strip left with nothing to paint is dropped.
    function clipStrips(strips, treatments) {
        const covers = (treatments || []).map(paintOf).filter(paint => paint && paint.coverage);
        if (!covers.length || !Array.isArray(strips)) return strips;
        return strips.map(strip => {
            const polygons = [];
            (strip.polygons || []).forEach(ring => {
                const feature = ringFeature(ring);
                if (!feature) { polygons.push(ring); return; }
                const box = bboxOf(feature.geometry.coordinates);
                if (!covers.some(cover => bboxesMeet(box, cover.bbox))) { polygons.push(ring); return; }
                const left = clipGeometry(feature.geometry, treatments);
                if (left === feature.geometry) { polygons.push(ring); return; }
                polygons.push(...leafletPolygons(left));
            });
            return { ...strip, polygons };
        }).filter(strip => strip.polygons.length);
    }

    return { clipStrips, clipGeometry, junctionSurfacePolygons, paintOf, unionOfRings, leafletPolygons, ringFeature };
});
