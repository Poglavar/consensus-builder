// How much room the road parcel actually leaves for lanes, and where the lane model disagrees
// with the land.
//
// The lane model says how wide the carriageway SHOULD be from tags and standard widths. The parcel
// says how much road land there IS. Neither is the answer on its own:
//
//   available = min(lane band, road parcel)
//
// It is an intersection, never a sum, and the parcel is a BOUND, never a target. A parcel much
// wider than a plausible carriageway is evidence it contains non-road land — the čestica north of
// Glavni kolodvor holds a park and the surrounding roads in one parcel — so filling it would pave
// the park.
//
// The reverse case is real too: sub-standard lane widths exist in the wild. Where the parcel is
// NARROWER than the lane model wants, that disagreement is reported with the parcel's
// classification score, so a low-score narrow parcel (likely misclassified) can be told from a
// high-score narrow one (likely a genuinely tight road). Silently clipping would throw that away.
//
// Pure and planar (metres, x east, y north), like corridor-clearance — projection stays with the
// caller. turf is injected because the parcel union is a GeoJSON operation.

(function (global) {
    'use strict';

    const resolve = (name, moduleId) => (typeof global[name] === 'function')
        ? global[name]
        : (typeof require === 'function' ? require(moduleId)[name] : null);
    const clearanceSamples = resolve('corridorClearanceSamples', './corridor-clearance.js');

    // Far enough to clear any real road parcel; beyond it the side is unbounded and the lane model
    // is the only constraint left.
    const PARCEL_MAX_REACH_M = 60;
    const STATION_STEP_M = 2;
    // Below this a shortfall is modelling noise — parcel edges are surveyed, lane widths are
    // nominal, and a few centimetres of disagreement says nothing.
    const SHORTFALL_TOLERANCE_M = 0.35;
    // A pinch has to hold across a tenth of the section before it reshapes the whole cross-section.
    const SUSTAINED_PERCENTILE = 0.1;

    function finite(value) {
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }

    // The lane band: how far the carriageway reaches either side of the alignment. Signed offsets,
    // so left and right are measured separately — a road widened on one side only is the normal case.
    function laneBandHalfWidths(lanes) {
        let left = 0;
        let right = 0;
        (lanes || []).forEach(lane => {
            const offset = finite(lane?.offset);
            if (offset === null) return;
            const half = Math.max(0.7, (finite(lane?.width) ?? 3) / 2);
            left = Math.max(left, offset + half);
            right = Math.max(right, -(offset - half));
        });
        return { leftM: Math.max(0, left), rightM: Math.max(0, right) };
    }

    // Adjacent road parcels tile, so their shared edges are not the edge of the road. Casting rays
    // at every parcel ring would stop at the first internal boundary and understate the width by
    // most of the street. Only the union's outline is a real limit.
    function parcelBoundaryObstacle(parcels, options) {
        const turf = options?.turf || global.turf;
        const rings = [];
        (parcels || []).forEach(parcel => {
            (parcel?.rings || []).forEach(ring => {
                if (Array.isArray(ring) && ring.length >= 3) rings.push(ring);
            });
        });
        if (!rings.length) return null;
        if (rings.length === 1 || !turf?.union) {
            return { id: 'road-parcels', kind: 'road_parcel', rings };
        }
        try {
            const polygons = rings.map(ring => turf.polygon([closeRing(ring)]));
            const merged = polygons.reduce((accumulated, polygon) => (
                accumulated ? turf.union(turf.featureCollection([accumulated, polygon])) : polygon
            ), null);
            const unionRings = collectRings(merged?.geometry);
            return { id: 'road-parcels', kind: 'road_parcel', rings: unionRings.length ? unionRings : rings };
        } catch (_) {
            // A union failure must not silently become "no constraint": fall back to every ring,
            // which under-reports width rather than inventing room that is not there.
            return { id: 'road-parcels', kind: 'road_parcel', rings };
        }
    }

    function closeRing(ring) {
        const first = ring[0];
        const last = ring[ring.length - 1];
        return (first[0] === last[0] && first[1] === last[1]) ? ring : [...ring, first];
    }

    function collectRings(geometry) {
        if (!geometry) return [];
        if (geometry.type === 'Polygon') return geometry.coordinates.map(ring => ring.slice(0, -1));
        if (geometry.type === 'MultiPolygon') {
            return geometry.coordinates.flatMap(polygon => polygon.map(ring => ring.slice(0, -1)));
        }
        return [];
    }

    // The width a low percentile of stations can hold — a pinch has to persist to count. The
    // tightest station is still reported, as the worst point, but it does not set the geometry.
    function percentileOf(values, fraction) {
        if (!values.length) return null;
        const sorted = [...values].sort((left, right) => left - right);
        const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(fraction * (sorted.length - 1))));
        return sorted[index];
    }

    function sustainedFit(stations, band, options = {}) {
        const fraction = finite(options.sustainedPercentile) ?? SUSTAINED_PERCENTILE;
        const bounded = stations.filter(station => !station.unbounded);
        // Mostly unbounded means the parcel never really constrained this section.
        if (bounded.length < Math.max(3, stations.length * 0.25)) return null;
        const left = percentileOf(bounded.map(station => station.fitLeftM), fraction);
        const right = percentileOf(bounded.map(station => station.fitRightM), fraction);
        if (left === null || right === null) return null;
        return {
            fitLeftM: left,
            fitRightM: right,
            shortfallM: Math.max(0, band.leftM - left) + Math.max(0, band.rightM - right)
        };
    }

    function fitSectionToParcels(centrelineXY, lanes, parcels, options = {}) {
        const band = laneBandHalfWidths(lanes);
        const maxDistance = finite(options.maxDistanceM) ?? PARCEL_MAX_REACH_M;
        const obstacle = parcelBoundaryObstacle(parcels, options);
        if (!obstacle || typeof clearanceSamples !== 'function') {
            return { band, stations: [], covered: false, tightest: null, shortfallM: 0 };
        }

        const samples = clearanceSamples(centrelineXY, [obstacle], {
            stationStep: finite(options.stationStepM) ?? STATION_STEP_M,
            maxDistance
        });
        if (!samples.length) {
            return { band, stations: [], covered: false, tightest: null, shortfallM: 0 };
        }

        let tightest = null;
        const stations = samples.map(sample => {
            // No hit means the ray never left road land within reach: unbounded, so the lane model
            // is the only limit. A floor, not a measurement — flagged so it cannot read as one.
            const availableLeftM = sample.left ? sample.left.distance : null;
            const availableRightM = sample.right ? sample.right.distance : null;
            const fitLeftM = availableLeftM === null ? band.leftM : Math.min(band.leftM, availableLeftM);
            const fitRightM = availableRightM === null ? band.rightM : Math.min(band.rightM, availableRightM);
            const shortfallM = Math.max(0, band.leftM - fitLeftM) + Math.max(0, band.rightM - fitRightM);
            const station = {
                arcM: sample.s,
                point: sample.point,
                availableLeftM,
                availableRightM,
                unbounded: availableLeftM === null || availableRightM === null,
                fitLeftM,
                fitRightM,
                shortfallM
            };
            if (!tightest || shortfallM > tightest.shortfallM) tightest = station;
            return station;
        });

        return {
            band,
            stations,
            covered: true,
            tightest,
            // What the section is narrowed to. NOT the tightest station: parcel outlines are
            // surveyed polygons with corners and notches, and a single station clipping a corner
            // is noise, not a pinch. Driving geometry from the extreme let ONE 4.35 m sample
            // narrow 257 m of avenue whose parcel is 41.7 m wide for its whole length.
            sustained: sustainedFit(stations, band, options),
            shortfallM: tightest ? tightest.shortfallM : 0
        };
    }

    // Which parcel the road is actually standing in at the tightest station. Listing every parcel
    // in the viewport would bury the one score that decides whether this is a misclassification.
    function parcelsAtStation(parcels, station, options = {}) {
        const turf = options.turf || global.turf;
        if (!turf?.booleanPointInPolygon || !station?.point) return [];
        return (parcels || []).filter(parcel => (parcel?.rings || []).some(ring => {
            if (!Array.isArray(ring) || ring.length < 3) return false;
            try {
                return turf.booleanPointInPolygon(turf.point(station.point), turf.polygon([closeRing(ring)]));
            } catch (_) {
                return false;
            }
        }));
    }

    // The disagreement is data, not an error to swallow. Required, available and the CONSTRAINING
    // parcel's score travel with it, because a narrow parcel scoring 40 is probably a
    // misclassification while one scoring 90 is probably a genuinely tight road.
    function parcelFitProblem(section, fit, parcels, options = {}) {
        const tolerance = finite(options.toleranceM) ?? SHORTFALL_TOLERANCE_M;
        const sustained = fit?.sustained;
        if (!fit?.covered || !sustained || sustained.shortfallM <= tolerance) return null;
        const here = parcelsAtStation(parcels, fit.tightest, options);
        const scores = (here.length ? here : [])
            .map(parcel => finite(parcel?.score))
            .filter(score => score !== null);
        return {
            id: `problem:parcel-fit:${section?.id}`,
            type: 'lane_band_exceeds_road_parcel',
            severity: 'warning',
            sectionIds: [section?.id],
            sourceWayIds: section?.sourceWayId == null ? [] : [section.sourceWayId],
            requiredWidthM: Number((fit.band.leftM + fit.band.rightM).toFixed(2)),
            availableWidthM: Number((sustained.fitLeftM + sustained.fitRightM).toFixed(2)),
            shortfallM: Number(sustained.shortfallM.toFixed(2)),
            // The worst single station, reported but deliberately not what narrowed the road.
            tightestWidthM: Number((fit.tightest.fitLeftM + fit.tightest.fitRightM).toFixed(2)),
            atArcM: Number(fit.tightest.arcM.toFixed(1)),
            parcelScores: scores,
            message: `Lane model wants ${(fit.band.leftM + fit.band.rightM).toFixed(1)} m of carriageway `
                + `but the road parcel leaves ${(sustained.fitLeftM + sustained.fitRightM).toFixed(1)} m `
                + `over most of the section. Either the lane count is wrong or the `
                + `parcel is misclassified (scores: ${scores.length ? scores.join(', ') : 'unknown'}).`
        };
    }

    // Traffic strips are what the lane band measured, so they are what the parcel constrains.
    // Sidewalks and verges are the remainder and belong to the edge fill, which has its own limit.
    const TRAFFIC_STRIP_TYPES = new Set(['driving', 'bus']);
    // A lane narrower than this is not a lane. Below it the parcel and the lane count cannot both
    // be right, and silently drawing a 1.8 m carriageway would hide that.
    const MIN_TRAFFIC_LANE_WIDTH_M = 2.4;

    // Narrows the cross-section to the room the parcel actually leaves, so the painted lanes and
    // their markings land on real asphalt instead of overhanging it. Uses the section's TIGHTEST
    // station: one profile per section is the model, so it has to hold everywhere in the section.
    function scaleProfileToFit(profile, fit, options = {}) {
        const strips = profile?.strips;
        if (!Array.isArray(strips) || !strips.length) return { profile, scaled: false };
        const tolerance = finite(options.toleranceM) ?? SHORTFALL_TOLERANCE_M;
        const sustained = fit?.sustained;
        if (!fit?.covered || !sustained || sustained.shortfallM <= tolerance) {
            return { profile, scaled: false };
        }

        const required = fit.band.leftM + fit.band.rightM;
        const available = sustained.fitLeftM + sustained.fitRightM;
        if (!(required > 0) || !(available > 0)) return { profile, scaled: false };

        const trafficWidth = strips.reduce(
            (total, strip) => total + (TRAFFIC_STRIP_TYPES.has(strip.type) ? (finite(strip.width) ?? 0) : 0),
            0
        );
        if (!(trafficWidth > 0)) return { profile, scaled: false };

        // Take the shortfall out of the traffic strips only, and never below a drivable lane.
        const target = Math.max(0, trafficWidth - (required - available));
        const scale = Math.min(1, target / trafficWidth);
        const minWidth = finite(options.minLaneWidthM) ?? MIN_TRAFFIC_LANE_WIDTH_M;
        let floored = false;
        const nextStrips = strips.map(strip => {
            if (!TRAFFIC_STRIP_TYPES.has(strip.type)) return strip;
            const width = finite(strip.width);
            if (width === null) return strip;
            const scaledWidth = width * scale;
            if (scaledWidth < minWidth) floored = true;
            return { ...strip, width: Math.max(minWidth, Number(scaledWidth.toFixed(3))) };
        });

        return {
            profile: { ...profile, strips: nextStrips },
            scaled: true,
            scale: Number(scale.toFixed(4)),
            // True when the parcel cannot hold this many lanes even at minimum width — the lane
            // COUNT is then the thing that is wrong, not the widths, and that is a different fix.
            flooredBelowParcel: floored
        };
    }

    const api = {
        PARCEL_MAX_REACH_M,
        STATION_STEP_M,
        SHORTFALL_TOLERANCE_M,
        SUSTAINED_PERCENTILE,
        sustainedFit,
        TRAFFIC_STRIP_TYPES,
        MIN_TRAFFIC_LANE_WIDTH_M,
        scaleProfileToFit,
        laneBandHalfWidths,
        parcelBoundaryObstacle,
        parcelsAtStation,
        fitSectionToParcels,
        parcelFitProblem
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (global) global.LaneParcelFit = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
