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
        let travelled = 0;
        for (let i = 0; i < pointsXY.length - 1; i += 1) {
            const a = pointsXY[i];
            const b = pointsXY[i + 1];
            const dx = b[0] - a[0];
            const dy = b[1] - a[1];
            const length2 = dx * dx + dy * dy;
            if (length2 < EDGE_FILL_EPS) continue;
            const length = Math.sqrt(length2);
            const raw = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length2;
            const t = Math.max(0, Math.min(1, raw));
            const distance = Math.hypot(point[0] - (a[0] + dx * t), point[1] - (a[1] + dy * t));
            if (!best || distance < best.distance) {
                const cross = dx * (point[1] - a[1]) - dy * (point[0] - a[0]);
                best = {
                    distance,
                    // Positive is left of travel, matching the strip spans and the clearance sampler.
                    signed: cross >= 0 ? distance : -distance,
                    // How far along the road it sits — which stretch of pavement it speaks for.
                    chainage: travelled + t * length,
                    abreast: !(i === 0 && t <= 0) && !(i === pointsXY.length - 2 && t >= 1)
                };
            }
            travelled += length;
        }
        return best;
    }

    // How far along the road a parcel fronts, and how close it comes to the centerline.
    //
    // The extent is what lets a parcel's building line apply to a STRETCH of pavement rather than to
    // the parcel's own polygon. That distinction was the bug: the land between the kerb and the
    // property line is road land, not the parcel's, so a cut clipped to the parcel started several
    // metres out and never touched the pavement — and the kerb-connectivity test then correctly
    // threw every one of them away.
    //
    // No `abreast` test here, unlike the building line: a parcel running past the end of this
    // stretch still fronts the part it overlaps, and the projection has already clamped its chainage
    // to the road. Requiring abreast dropped every parcel with a corner on the road's first or last
    // vertex, which is most of them.
    function corridorEdgeFillParcelExtent(pointsXY, rings, side) {
        const sign = side === 'right' ? -1 : 1;
        let sMin = Infinity;
        let sMax = -Infinity;
        let nearest = Infinity;
        (rings || []).forEach(ring => {
            if (!Array.isArray(ring)) return;
            ring.forEach(vertex => {
                const projection = projectPointOntoPolyline(pointsXY, vertex);
                if (!projection) return;
                const offset = projection.signed * sign;
                if (offset <= 0) return; // the other side of the road
                if (projection.chainage < sMin) sMin = projection.chainage;
                if (projection.chainage > sMax) sMax = projection.chainage;
                if (offset < nearest) nearest = offset;
            });
        });
        if (!Number.isFinite(sMin) || !Number.isFinite(sMax) || sMax - sMin < EDGE_FILL_EPS) return null;
        return { sMin, sMax, nearest };
    }

    // The stretch of centerline between two chainages, as its own polyline. The ends are
    // interpolated, so the slice starts and stops exactly where the parcel does.
    function corridorEdgeFillSlicePolyline(pointsXY, sMin, sMax) {
        if (!Array.isArray(pointsXY) || pointsXY.length < 2) return null;
        if (!Number.isFinite(sMin) || !Number.isFinite(sMax) || sMax <= sMin) return null;
        const at = (a, b, ratio) => [a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio];
        const slice = [];
        let travelled = 0;
        for (let i = 0; i < pointsXY.length - 1; i += 1) {
            const a = pointsXY[i];
            const b = pointsXY[i + 1];
            const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
            if (length < EDGE_FILL_EPS) continue;
            const start = travelled;
            const end = travelled + length;
            if (end >= sMin && start <= sMax) {
                const from = Math.max(sMin, start);
                const to = Math.min(sMax, end);
                const first = at(a, b, (from - start) / length);
                const last = at(a, b, (to - start) / length);
                if (!slice.length) slice.push(first);
                const tail = slice[slice.length - 1];
                if (Math.hypot(last[0] - tail[0], last[1] - tail[1]) > EDGE_FILL_EPS) slice.push(last);
            }
            travelled = end;
        }
        return slice.length >= 2 ? slice : null;
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

    // One cut per STRETCH of road: from the kerb out to the frontage line of whichever parcel is on
    // the street there. `parcels` is [{ parcelRings, rings }] — the parcel outline and its main
    // building's, both in the planar road frame. `buildStrip(offset, sMin, sMax)` returns the
    // pavement from the lane's inner seam out to `offset` over that stretch, as a lat/lng feature;
    // the caller owns the projection, and with it the side's sign.
    function corridorEdgeFillParcelCuts(pointsXY, parcels, side, options = {}, buildStrip) {
        if (typeof buildStrip !== 'function') return [];
        const step = Number(options.stationStep) > 0 ? Number(options.stationStep) : 1;

        const candidates = [];
        (parcels || []).forEach(parcel => {
            if (!parcel || !parcel.parcelRings) return;
            const extent = corridorEdgeFillParcelExtent(pointsXY, parcel.parcelRings, side);
            if (!extent) return;
            const lineOffset = corridorEdgeFillBuildingLineOffset(pointsXY, parcel.rings, side, options);
            if (!Number.isFinite(lineOffset)) return;
            candidates.push({ ...extent, lineOffset });
        });
        if (!candidates.length) return [];

        let total = 0;
        for (let i = 1; i < pointsXY.length; i += 1) {
            total += Math.hypot(pointsXY[i][0] - pointsXY[i - 1][0], pointsXY[i][1] - pointsXY[i - 1][1]);
        }
        if (!(total > 0)) return [];

        // Walk the road and ask, at each station, which parcel is the one ON the street here: of
        // those fronting this spot, the nearest to the centerline. A back lot never wins, and a big
        // parcel cannot speak for the stretch in front of its neighbours — which is what an
        // interval-claiming rule let it do, collapsing a whole block to one frontage line.
        const stations = Math.max(1, Math.ceil(total / step));
        const picked = new Array(stations).fill(null);
        for (let i = 0; i < stations; i += 1) {
            const s = Math.min(total, (i + 0.5) * step);
            let best = null;
            candidates.forEach(candidate => {
                if (s < candidate.sMin || s > candidate.sMax) return;
                if (!best || candidate.nearest < best.nearest) best = candidate;
            });
            picked[i] = best ? best.lineOffset : null;
        }

        // Consecutive stations sharing a frontage line are one cut: the edge steps only where the
        // parcel does.
        const cuts = [];
        let i = 0;
        while (i < stations) {
            if (picked[i] === null) { i += 1; continue; }
            let j = i;
            while (j + 1 < stations && picked[j + 1] === picked[i]) j += 1;
            const strip = buildStrip(picked[i], i * step, Math.min(total, (j + 1) * step));
            if (strip) cuts.push(strip);
            i = j + 1;
        }
        return cuts;
    }

    // The filled lane: the drawn width, plus every cut the band reaches and the kerb connects to.
    // A cut is a real polygon — a road parcel, or a parcel's frontage slice — so its own edge is
    // what draws the pavement's edge.
    function corridorEdgeFillRegion(band, nominal, cuts, options = {}) {
        const turf = options.turf || global.turf;
        if (!turf || !band) return nominal || null;
        const minArea = Number.isFinite(options.minArea) ? Number(options.minArea) : 0.5;

        // Why a cut was dropped, when the caller wants to know. Three boolean operations can each
        // fail quietly on awkward geometry, and a silent drop is indistinguishable from "there was
        // nothing there" — which is the confusion this counts its way out of.
        const report = options.report || {};
        const note = key => { report[key] = (report[key] || 0) + 1; };

        let region = nominal || null;
        (cuts || []).forEach(cut => {
            if (!cut) return note('nullCut');
            let piece = null;
            try {
                piece = turf.intersect(cut, band);
            } catch (error) {
                report.intersectError = String(error && error.message).slice(0, 80);
                return note('intersectThrew');
            }
            if (!piece) return note('outsideBand');
            if (turf.area(piece) < minArea) return note('slivers');
            // Connected to the kerb, or it is not pavement: a parcel across the street, or one the
            // band reaches but that does not front this road, is reached by geometry, not by a walker.
            //
            // TOUCHING counts. Measuring the overlap by AREA looked equivalent and is not: an
            // applied road splits the parcels it crosses along its own footprint, so the leftover
            // road land lies exactly BESIDE the pavement, sharing an edge with it. A shared edge has
            // zero area, so the area test called the pavement's own neighbour unreachable and threw
            // away the one piece the fill exists to take.
            if (nominal) {
                let touches = false;
                try {
                    touches = turf.booleanIntersects(piece, nominal);
                } catch (error) {
                    report.sharedError = String(error && error.message).slice(0, 80);
                    return note('sharedThrew');
                }
                if (!touches) return note('notConnected');
            }
            if (!region) { region = piece; return note('kept'); }
            let merged = null;
            try {
                merged = turf.union(region, piece);
            } catch (error) {
                report.unionError = String(error && error.message).slice(0, 80);
                return note('unionThrew');
            }
            if (!merged) return note('unionNull');
            region = merged;
            note('kept');
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
        corridorEdgeFillParcelExtent,
        corridorEdgeFillSlicePolyline,
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
