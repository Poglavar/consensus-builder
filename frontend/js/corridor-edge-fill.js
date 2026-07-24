// Corridor edge fill: the outer edge of an edge lane is not a constant offset. A real footway runs
// from the kerb to whatever bounds the street, so its inner boundary is a clean offset of the
// centerline while its outer one is irregular. What bounds the street is a choice between two
// EXCLUSIVE limits, never a sum of both:
//
//   road parcels — the pavement takes the road land and stops at its edge, buildings ignored;
//   buildings    — the road parcel is ignored, and each parcel along the street gives up the slice
//                  in front of its main building.
//
// Both come out of one mechanism: a BAND saying how far the fill may ever reach (constant, easing
// back to the drawn width at a welded end so two corridors' fills do not fight in a junction), and
// a list of CUTS — real polygons — of which the band keeps whatever is connected to the kerb. The
// boundary is therefore always some real polygon's own edge, never a line through sampled points.
//
// The building-line rule is what keeps that edge readable: one parcel gets ONE line, set by its
// biggest building, for its whole frontage. Following each building's outline instead bulges the
// pavement into every gap between them — what a raw flood fill does, and why it looked wrong.
//
// The lane's stored width remains its MINIMUM: the fill only reaches outward from there. The offset
// half is pure and planar (metres, x east, y north) like corridor-clearance.js; the region half is
// GeoJSON in lat/lng (turf's frame).
(function (global) {
    'use strict';

    // Browser: corridor-profile.js and corridor-clearance.js load first and their top-level
    // declarations are globals. Node (vitest): require them — never re-declare, so the two realms
    // share one implementation.
    const resolve = (name, moduleId) => (typeof global[name] === 'function')
        ? global[name]
        : (typeof require === 'function' ? require(moduleId)[name] : null);
    const offsetPolylineVariable = resolve('offsetPolylineVariable', './corridor-clearance.js');
    const densifyPolylineXY = resolve('densifyPolylineXY', './corridor-clearance.js');
    const offsetPolylinePlanar = resolve('offsetPolylinePlanar', './corridor-profile.js');
    const corridorStripSpans = resolve('corridorStripSpans', './corridor-profile.js');

    // Lane types that really run to the boundary of the street. A verge or a parking lane stops at
    // its drawn width; a footway takes whatever is left over between the kerb and the frontage.
    const EDGE_FILL_TYPES = new Set(['sidewalk']);
    // The outermost the fill may ever reach past the centerline's drawn edge. Not a shaping rule —
    // the cuts do the shaping — just a bound that keeps a mis-classified parcel, or a building far
    // up a driveway, from turning half a block into pavement.
    const EDGE_FILL_MAX_REACH = 25;
    const EDGE_FILL_EPS = 1e-9;

    const smoothstep = t => (t <= 0 ? 0 : (t >= 1 ? 1 : t * t * (3 - 2 * t)));

    // ---------------------------------------------------------------------------
    // The band (planar)
    // ---------------------------------------------------------------------------

    // Per-vertex outer offsets of the band: the full reach, eased back to the drawn width over
    // `taperMeters` toward each welded end.
    function corridorEdgeFillBandOffsets(pointsXY, options = {}) {
        if (!Array.isArray(pointsXY) || pointsXY.length < 2) return null;
        const minOffset = Number(options.minOffset);
        if (!Number.isFinite(minOffset) || minOffset <= 0) return null;
        const maxOffset = Number.isFinite(options.maxOffset)
            ? Math.max(Number(options.maxOffset), minOffset)
            : minOffset + EDGE_FILL_MAX_REACH;
        const taper = Number(options.taperMeters) > 0 ? Number(options.taperMeters) : Math.max(10, minOffset * 2);

        const arclength = [0];
        for (let i = 1; i < pointsXY.length; i += 1) {
            arclength.push(arclength[i - 1] + Math.hypot(
                pointsXY[i][0] - pointsXY[i - 1][0],
                pointsXY[i][1] - pointsXY[i - 1][1]
            ));
        }
        const total = arclength[arclength.length - 1];
        return arclength.map(distance => {
            let factor = 1;
            if (options.taperStart) factor *= smoothstep(distance / taper);
            if (options.taperEnd) factor *= smoothstep((total - distance) / taper);
            return minOffset + (maxOffset - minOffset) * factor;
        });
    }

    // The band as one planar ring: its outer boundary at those offsets, its inner boundary the
    // ordinary constant offset the lane shares with its neighbour. The centerline is densified
    // first — a long straight edge has no vertices for the end taper to bend at.
    function corridorEdgeFillBandRing(pointsXY, innerOffset, options = {}) {
        if (typeof offsetPolylineVariable !== 'function' || typeof densifyPolylineXY !== 'function') return null;
        if (typeof offsetPolylinePlanar !== 'function') return null;
        if (!Array.isArray(pointsXY) || pointsXY.length < 2 || !Number.isFinite(innerOffset)) return null;
        const spacing = Number(options.spacing) > 0 ? Number(options.spacing) : 2;
        // Both boundaries come off the SAME densified polyline, so they share their joint positions.
        const densified = densifyPolylineXY(pointsXY, spacing);
        const offsets = corridorEdgeFillBandOffsets(densified, options);
        if (!offsets) return null;
        const sign = options.side === 'right' ? -1 : 1;
        const outer = offsetPolylineVariable(densified, offsets.map(value => value * sign));
        const inner = offsetPolylinePlanar(densified, innerOffset);
        if (!outer || !inner) return null;
        return [...outer, ...inner.reverse()];
    }

    // ---------------------------------------------------------------------------
    // The building line (planar)
    // ---------------------------------------------------------------------------

    // Where a point sits in the road's frame: how far off the centerline, on which side, and
    // whether it is abreast of the road at all — a point whose nearest place on the centerline is
    // one of its ends lies past the road, not beside it, and must not set a frontage line.
    function projectPointOntoPolyline(pointsXY, point) {
        if (!Array.isArray(pointsXY) || pointsXY.length < 2 || !Array.isArray(point)) return null;
        let best = null;
        for (let i = 0; i < pointsXY.length - 1; i += 1) {
            const a = pointsXY[i];
            const b = pointsXY[i + 1];
            const dx = b[0] - a[0];
            const dy = b[1] - a[1];
            const length2 = dx * dx + dy * dy;
            if (length2 < EDGE_FILL_EPS) continue;
            const raw = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length2;
            const t = Math.max(0, Math.min(1, raw));
            const distance = Math.hypot(point[0] - (a[0] + dx * t), point[1] - (a[1] + dy * t));
            if (best && distance >= best.distance) continue;
            const cross = dx * (point[1] - a[1]) - dy * (point[0] - a[0]);
            best = {
                distance,
                // Positive is left of travel, matching the strip spans and the clearance sampler.
                signed: cross >= 0 ? distance : -distance,
                abreast: !(i === 0 && t <= 0) && !(i === pointsXY.length - 2 && t >= 1)
            };
        }
        return best;
    }

    // The offset at which a building's face sits, in the road's frame — the closest its outline
    // comes to the centerline on this side. This ONE number becomes the frontage line for the whole
    // parcel the building stands on, which is what makes the pavement edge a clean step per parcel
    // rather than a bulge per building.
    function corridorEdgeFillBuildingLineOffset(pointsXY, rings, side, options = {}) {
        const sign = side === 'right' ? -1 : 1;
        const maxOffset = Number.isFinite(options.maxOffset) ? Number(options.maxOffset) : Infinity;
        let best = Infinity;
        (rings || []).forEach(ring => {
            if (!Array.isArray(ring)) return;
            ring.forEach(vertex => {
                const projection = projectPointOntoPolyline(pointsXY, vertex);
                if (!projection || !projection.abreast) return;
                const offset = projection.signed * sign;
                if (offset <= 0) return; // the other side of the road
                if (offset < best) best = offset;
            });
        });
        if (!Number.isFinite(best)) return null;
        // A building the road already reaches into cannot pull the frontage line inward: the drawn
        // width is a minimum, and the overlap stays an ordinary collision for the cut/demolish
        // machinery to resolve.
        const floor = Number.isFinite(options.minOffset) ? Number(options.minOffset) : 0;
        return Math.min(Math.max(best, floor), maxOffset);
    }

    // ---------------------------------------------------------------------------
    // The region (GeoJSON in lat/lng — turf.area reads the frame for the m² thresholds)
    // ---------------------------------------------------------------------------

    // One cut per parcel: the strip in front of that parcel's main building, clipped to the parcel.
    // Clipping is the whole point — it is what makes the pavement edge step at each property line
    // and stay put across the gaps between buildings, instead of bulging into every one of them.
    //
    // `parcels` is [{ feature, rings }] — the parcel polygon in lat/lng and its main building's
    // outline in the planar road frame. `buildStrip(offset)` returns the frontage strip out to that
    // offset as a lat/lng feature; the caller owns the projection, and with it the side's sign.
    function corridorEdgeFillParcelCuts(pointsXY, parcels, side, options = {}, buildStrip) {
        const turf = options.turf || global.turf;
        if (!turf || typeof buildStrip !== 'function') return [];
        const cuts = [];
        (parcels || []).forEach(parcel => {
            if (!parcel || !parcel.feature || !parcel.rings) return;
            const lineOffset = corridorEdgeFillBuildingLineOffset(pointsXY, parcel.rings, side, options);
            if (!Number.isFinite(lineOffset)) return;
            const frontage = buildStrip(lineOffset);
            if (!frontage) return;
            try {
                const cut = turf.intersect(frontage, parcel.feature);
                if (cut) cuts.push(cut);
            } catch (_) { }
        });
        return cuts;
    }

    // The filled lane: the drawn width, plus every cut the band reaches and the kerb connects to.
    // A cut is a real polygon — a road parcel, or a parcel's frontage slice — so its own edge is
    // what draws the pavement's edge.
    function corridorEdgeFillRegion(band, nominal, cuts, options = {}) {
        const turf = options.turf || global.turf;
        if (!turf || !band) return nominal || null;
        const minArea = Number.isFinite(options.minArea) ? Number(options.minArea) : 0.5;

        let region = nominal || null;
        (cuts || []).forEach(cut => {
            if (!cut) return;
            try {
                const piece = turf.intersect(cut, band);
                if (!piece || turf.area(piece) < minArea) return;
                // Connected to the kerb, or it is not pavement: a parcel across the street, or one
                // the band reaches but that does not front this road, is reached by geometry and
                // not by a walker.
                if (nominal) {
                    const shared = turf.intersect(piece, nominal);
                    if (!shared || turf.area(shared) < minArea) return;
                }
                region = region ? (turf.union(region, piece) || region) : piece;
            } catch (_) { }
        });
        return region;
    }

    // Which sides of a cross-section fill, and from what nominal offset. A side fills when its
    // OUTERMOST lane is a fillable type — the default the editor offers whenever a road ends in a
    // footway, which is what a street normally is.
    function corridorEdgeFillSides(profile) {
        if (typeof corridorStripSpans !== 'function') return { left: null, right: null };
        const spans = corridorStripSpans(profile);
        if (!spans.length) return { left: null, right: null };
        const first = spans[0];
        const last = spans[spans.length - 1];
        return {
            // minOffset is the lane's OUTER offset at its nominal width; innerOffset is the seam it
            // shares with its neighbour and never moves.
            left: EDGE_FILL_TYPES.has(first.type)
                ? { index: first.index, type: first.type, minOffset: first.left, innerOffset: first.right }
                : null,
            right: EDGE_FILL_TYPES.has(last.type)
                ? { index: last.index, type: last.type, minOffset: -last.right, innerOffset: last.left }
                : null
        };
    }

    const api = {
        corridorEdgeFillBandOffsets,
        corridorEdgeFillBandRing,
        projectPointOntoPolyline,
        corridorEdgeFillBuildingLineOffset,
        corridorEdgeFillParcelCuts,
        corridorEdgeFillRegion,
        corridorEdgeFillSides,
        EDGE_FILL_TYPES,
        EDGE_FILL_MAX_REACH
    };

    Object.assign(global, api);

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
