// available = min(lane band, road parcel). The rules that make that mean something:
// the parcel is a BOUND and never a target (a čestica can hold a park as well as the road), the
// shared edge between two abutting road parcels is not the edge of the road, and where the parcel
// is narrower than the lane model the disagreement is reported WITH the constraining parcel's
// score — because that is what distinguishes a misclassified parcel from a genuinely tight road.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const LaneParcelFit = require('../../frontend/js/lane-parcel-fit.js');

const {
    laneBandHalfWidths,
    fitSectionToParcels,
    parcelFitProblem,
    SHORTFALL_TOLERANCE_M
} = LaneParcelFit;

const CENTRELINE = [[0, 0], [100, 0]];
// Four 3.5 m lanes: the band wants 7 m either side of the alignment.
const FOUR_LANES = [
    { offset: -5.25, width: 3.5 }, { offset: -1.75, width: 3.5 },
    { offset: 1.75, width: 3.5 }, { offset: 5.25, width: 3.5 }
];
const WIDE_PARCEL = [{ score: 70, rings: [[[0, -10], [100, -10], [100, 10], [0, 10]]] }];
// A single-point notch: the boundary dips to 9 m at exactly x=50 and reopens. Parcel outlines are
// surveyed polygons full of corners like this, and one station clipping one is noise, not a pinch.
const NOTCHED_PARCEL = [{
    score: 40,
    rings: [[[0, -10], [40, -10], [50, -4.5], [60, -10], [100, -10],
        [100, 10], [60, 10], [50, 4.5], [40, 10], [0, 10]]]
}];
// A narrow stretch that actually holds: 10.5 m across from x=30 to x=80, half the section.
// Deliberately above 4 x MIN_TRAFFIC_LANE_WIDTH_M, so this fixture tests SCALING; the floor gets
// its own test with a parcel too narrow for four lanes at any drivable width.
const PINCHED_PARCEL = [{
    score: 40,
    rings: [[[0, -10], [30, -10], [30, -5.25], [80, -5.25], [80, -10], [100, -10],
        [100, 10], [80, 10], [80, 5.25], [30, 5.25], [30, 10], [0, 10]]]
}];
const fit = (lanes, parcels, options) =>
    fitSectionToParcels(CENTRELINE, lanes, parcels, { turf, ...options });

describe('laneBandHalfWidths', () => {
    it('measures each side separately, because roads widen asymmetrically', () => {
        expect(laneBandHalfWidths([{ offset: 1.75, width: 3.5 }, { offset: 5.25, width: 3.5 }]))
            .toEqual({ leftM: 7, rightM: 0 });
    });

    it('ignores a lane with no offset instead of parking it on the centreline', () => {
        // Number(null) is 0, which is a real offset — it would silently claim half a lane of band.
        expect(laneBandHalfWidths([{ offset: null, width: 3.5 }])).toEqual({ leftM: 0, rightM: 0 });
        expect(laneBandHalfWidths([{ offset: undefined, width: 3.5 }])).toEqual({ leftM: 0, rightM: 0 });
    });

    it('gives a lane with no stated width the standard one', () => {
        expect(laneBandHalfWidths([{ offset: 0 }])).toEqual({ leftM: 1.5, rightM: 1.5 });
    });
});

describe('the parcel as a bound, not a target', () => {
    it('leaves the lane band alone where the parcel is wider than it', () => {
        const result = fit(FOUR_LANES, WIDE_PARCEL);
        const mid = result.stations[Math.floor(result.stations.length / 2)];
        expect(mid.availableLeftM).toBeCloseTo(10, 6);
        // 10 m of road land, but the lane model only claims 7 — the extra is not carriageway.
        expect(mid.fitLeftM).toBe(7);
        expect(result.shortfallM).toBe(0);
    });

    it('never widens the band to fill the parcel', () => {
        const result = fit(FOUR_LANES, WIDE_PARCEL);
        expect(result.stations.every(s => s.fitLeftM <= 7 && s.fitRightM <= 7)).toBe(true);
    });

    it('raises nothing when the parcel is roomy', () => {
        expect(parcelFitProblem({ id: 's:1' }, fit(FOUR_LANES, WIDE_PARCEL), WIDE_PARCEL, { turf }))
            .toBeNull();
    });
});

describe('where the parcel is narrower than the lane model', () => {
    it('clips to the land and records how far short it falls', () => {
        const result = fit(FOUR_LANES, PINCHED_PARCEL);
        expect(result.tightest.fitLeftM).toBeLessThan(7);
        expect(result.shortfallM).toBeGreaterThan(3);
        // The narrow stretch runs x=30..80, so the worst station falls inside it.
        expect(result.tightest.arcM).toBeGreaterThan(28);
        expect(result.tightest.arcM).toBeLessThan(82);
        expect(result.sustained.shortfallM).toBeGreaterThan(SHORTFALL_TOLERANCE_M);
    });

    it('reports required, available and the CONSTRAINING parcel score', () => {
        const problem = parcelFitProblem(
            { id: 's:1', sourceWayId: 101 }, fit(FOUR_LANES, PINCHED_PARCEL), PINCHED_PARCEL, { turf }
        );
        expect(problem.type).toBe('lane_band_exceeds_road_parcel');
        expect(problem.severity).toBe('warning');
        expect(problem.requiredWidthM).toBe(14);
        expect(problem.availableWidthM).toBeLessThan(11);
        expect(problem.parcelScores).toEqual([40]);
        expect(problem.sourceWayIds).toEqual([101]);
        expect(problem.message).toMatch(/lane count is wrong or the .*parcel is misclassified/s);
    });

    it('names only the parcel the road stands in, not every parcel in the viewport', () => {
        const elsewhere = { score: 90, rings: [[[500, 500], [600, 500], [600, 600], [500, 600]]] };
        const problem = parcelFitProblem(
            { id: 's:1' }, fit(FOUR_LANES, [...PINCHED_PARCEL, elsewhere]),
            [...PINCHED_PARCEL, elsewhere], { turf }
        );
        expect(problem.parcelScores).toEqual([40]);
    });

    it('ignores a one-station notch — a pinch has to hold to reshape a road', () => {
        // This is the failure that made the rule: driving geometry from the tightest station let a
        // single 4.35 m sample narrow 257 m of avenue whose parcel is 41.7 m wide throughout.
        const result = fit(FOUR_LANES, NOTCHED_PARCEL);
        expect(result.tightest.shortfallM).toBeGreaterThan(2);
        expect(result.sustained.shortfallM).toBeLessThan(SHORTFALL_TOLERANCE_M);
        expect(parcelFitProblem({ id: 's:1' }, result, NOTCHED_PARCEL, { turf })).toBeNull();
    });

    it('still reports the worst single station, it just does not narrow on it', () => {
        const result = fit(FOUR_LANES, PINCHED_PARCEL);
        const problem = parcelFitProblem({ id: 's:1' }, result, PINCHED_PARCEL, { turf });
        expect(problem.availableWidthM).toBeGreaterThanOrEqual(problem.tightestWidthM);
        expect(problem.message).toMatch(/over most of the section/);
    });

    it('stays quiet for a disagreement inside surveying noise', () => {
        const barelyNarrow = [{ score: 70, rings: [[[0, -6.9], [100, -6.9], [100, 6.9], [0, 6.9]]] }];
        const result = fit(FOUR_LANES, barelyNarrow);
        expect(result.shortfallM).toBeGreaterThan(0);
        expect(result.shortfallM).toBeLessThan(SHORTFALL_TOLERANCE_M);
        expect(parcelFitProblem({ id: 's:1' }, result, barelyNarrow, { turf })).toBeNull();
    });
});

describe('abutting parcels', () => {
    it('ignores the shared edge — it is not the edge of the road', () => {
        // The shared edge is at y=3, deliberately OFF the centreline: an edge crossing the
        // alignment itself sits at distance zero and gets skipped by the ray epsilon anyway, so
        // it would pass whether or not the parcels were merged.
        const split = [
            { score: 70, rings: [[[0, -10], [100, -10], [100, 3], [0, 3]]] },
            { score: 70, rings: [[[0, 3], [100, 3], [100, 10], [0, 10]]] }
        ];
        const result = fit(FOUR_LANES, split);
        const mid = result.stations[Math.floor(result.stations.length / 2)];
        // Unmerged, the leftward ray stops at the shared edge and reports 3 m instead of 10.
        expect(mid.availableLeftM).toBeCloseTo(10, 6);
        expect(mid.availableRightM).toBeCloseTo(10, 6);
        expect(mid.fitLeftM).toBe(7);
    });
});

describe('honesty about what was measured', () => {
    it('marks a side the ray never bounded, so a floor cannot read as a measurement', () => {
        const openEnded = [{ score: 70, rings: [[[0, -500], [100, -500], [100, 500], [0, 500]]] }];
        const result = fit(FOUR_LANES, openEnded, { maxDistanceM: 20 });
        expect(result.stations.every(s => s.unbounded)).toBe(true);
        expect(result.stations.every(s => s.availableLeftM === null)).toBe(true);
        // Unbounded means the lane model is the only limit left — not zero room.
        expect(result.stations.every(s => s.fitLeftM === 7)).toBe(true);
    });

    it('reports no coverage rather than a fake fit when there are no parcels', () => {
        const result = fit(FOUR_LANES, []);
        expect(result.covered).toBe(false);
        expect(result.stations).toEqual([]);
        expect(parcelFitProblem({ id: 's:1' }, result, [], { turf })).toBeNull();
    });

    it('survives a malformed parcel ring', () => {
        const result = fit(FOUR_LANES, [{ score: 70, rings: [[[0, 0]]] }]);
        expect(result.covered).toBe(false);
    });
});

describe('scaleProfileToFit', () => {
    const PROFILE = {
        strips: [
            { type: 'sidewalk', width: 2 },
            { type: 'driving', width: 3.5 }, { type: 'driving', width: 3.5 },
            { type: 'driving', width: 3.5 }, { type: 'driving', width: 3.5 },
            { type: 'sidewalk', width: 2 }
        ]
    };
    const { scaleProfileToFit, MIN_TRAFFIC_LANE_WIDTH_M } = LaneParcelFit;

    it('leaves the cross-section alone where the parcel is roomy', () => {
        const result = scaleProfileToFit(PROFILE, fit(FOUR_LANES, WIDE_PARCEL), {});
        expect(result.scaled).toBe(false);
        expect(result.profile).toBe(PROFILE);
    });

    it('takes the shortfall out of the traffic lanes only', () => {
        const result = scaleProfileToFit(PROFILE, fit(FOUR_LANES, PINCHED_PARCEL), {});
        expect(result.scaled).toBe(true);
        const traffic = result.profile.strips.filter(s => s.type === 'driving');
        const total = traffic.reduce((sum, s) => sum + s.width, 0);
        const sustained = fit(FOUR_LANES, PINCHED_PARCEL).sustained;
        // Narrowed to the room the parcel sustains, not to its worst single station.
        expect(total).toBeCloseTo(sustained.fitLeftM + sustained.fitRightM, 1);
        // Sidewalks are the edge fill's business, with their own limit.
        expect(result.profile.strips.filter(s => s.type === 'sidewalk').every(s => s.width === 2)).toBe(true);
    });

    it('never narrows a lane below drivable, and says when it hit that floor', () => {
        const veryTight = [{ score: 70, rings: [[[0, -2.5], [100, -2.5], [100, 2.5], [0, 2.5]]] }];
        const result = scaleProfileToFit(PROFILE, fit(FOUR_LANES, veryTight), {});
        expect(result.profile.strips.filter(s => s.type === 'driving')
            .every(s => s.width === MIN_TRAFFIC_LANE_WIDTH_M)).toBe(true);
        // The parcel cannot hold four lanes at any drivable width: the COUNT is what is wrong.
        expect(result.flooredBelowParcel).toBe(true);
    });

    it('does not reshape the cross-section for a one-station notch', () => {
        // The problem being null is not enough: the SCALING path has to ignore the notch too, or
        // the road silently narrows with nothing said about it.
        expect(scaleProfileToFit(PROFILE, fit(FOUR_LANES, NOTCHED_PARCEL), {}).scaled).toBe(false);
    });

    it('does not narrow a section the parcel barely bounded', () => {
        // Two stations bounded out of fifty is not evidence about a road's width. Narrowing on it
        // would let a parcel corner clipped at one end reshape the whole section.
        // Both sides pinch to 3 m for x=40..60 and are far out of reach elsewhere, so a fifth of
        // the stations are bounded and the rest are not. Pinching only one side would leave every
        // station unbounded and the guard would never run — which is how this first passed.
        const almostOpen = [{
            score: 70,
            rings: [[[0, -500], [40, -500], [40, -3], [60, -3], [60, -500], [100, -500],
                [100, 500], [60, 500], [60, 3], [40, 3], [40, 500], [0, 500]]]
        }];
        const result = fit(FOUR_LANES, almostOpen, { maxDistanceM: 20 });
        expect(result.stations.filter(s => !s.unbounded).length).toBeLessThan(result.stations.length * 0.25);
        expect(result.sustained).toBeNull();
        expect(scaleProfileToFit(PROFILE, result, {}).scaled).toBe(false);
    });

    it('does not mutate the profile it was given', () => {
        const before = JSON.stringify(PROFILE);
        scaleProfileToFit(PROFILE, fit(FOUR_LANES, PINCHED_PARCEL), {});
        expect(JSON.stringify(PROFILE)).toBe(before);
    });

    it('has nothing to scale without traffic strips or coverage', () => {
        expect(scaleProfileToFit({ strips: [{ type: 'sidewalk', width: 2 }] },
            fit(FOUR_LANES, PINCHED_PARCEL), {}).scaled).toBe(false);
        expect(scaleProfileToFit(PROFILE, fit(FOUR_LANES, []), {}).scaled).toBe(false);
        expect(scaleProfileToFit(null, fit(FOUR_LANES, PINCHED_PARCEL), {}).scaled).toBe(false);
    });
});

describe('applied by the graph builder, before lanes derive from the profile', () => {
    const G = require('../../frontend/js/lane-topology-graph.js');
    const CorridorProfile = require('../../frontend/js/corridor-profile.js');
    const OsmProfile = require('../../frontend/js/osm-profile.js');

    // A 60 m two-lane street inside a road parcel only 5 m wide — the lane model wants ~6 m.
    const EVIDENCE = {
        type: 'FeatureCollection',
        features: [{
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: [[15.9600, 45.8000], [15.9608, 45.8000]] },
            properties: {
                osm_id: 101, highway_type: 'residential', name: 'Uska ulica',
                osm_node_ids: [1, 2], tags: { highway: 'residential', lanes: '2', name: 'Uska ulica' }
            }
        }]
    };
    const LAT0 = 45.8;
    const MX = 111320 * Math.cos(LAT0 * Math.PI / 180);
    const project = ([lng, lat]) => [(lng - 15.9604) * MX, (lat - LAT0) * 110540];
    const narrowParcel = [{
        score: 70, parcelId: 'HR-1-1',
        rings: [[[15.9598, 45.79998], [15.9610, 45.79998], [15.9610, 45.80002], [15.9598, 45.80002]]]
    }];

    function buildWith(parcelFit) {
        return G.build(EVIDENCE, {
            profileFromTags: CorridorProfile.corridorProfileFromOsmTags,
            orientProfile: OsmProfile.orientForRightHandTraffic,
            ...(parcelFit ? { parcelFit } : {})
        });
    }

    it('narrows the strips AND the lanes together, so they cannot disagree', () => {
        const graph = buildWith({ parcels: narrowParcel, turf, fit: LaneParcelFit, project });
        const traffic = graph.sections[0].profile.strips
            .filter(s => s.type === 'driving' || s.type === 'bus').map(s => s.width).sort();
        const lanes = graph.lanes.map(l => l.width).sort();
        expect(traffic).toEqual(lanes);
        expect(Math.max(...lanes)).toBeLessThan(3);
    });

    it('raises the disagreement rather than narrowing silently', () => {
        const graph = buildWith({ parcels: narrowParcel, turf, fit: LaneParcelFit, project });
        const problem = graph.problems.find(p => p.type === 'lane_band_exceeds_road_parcel');
        expect(problem).toBeTruthy();
        expect(problem.narrowedToFit).toBe(true);
        expect(problem.parcelScores).toEqual([70]);
    });

    it('builds unchanged when there is no parcel evidence — normal outside Zagreb', () => {
        const withParcels = buildWith({ parcels: narrowParcel, turf, fit: LaneParcelFit, project });
        const without = buildWith(null);
        expect(without.problems.some(p => p.type === 'lane_band_exceeds_road_parcel')).toBe(false);
        expect(Math.max(...without.lanes.map(l => l.width)))
            .toBeGreaterThan(Math.max(...withParcels.lanes.map(l => l.width)));
    });

    it('projects the parcels itself — lat/lng rings against a metre centreline measure nothing', () => {
        // This shipped once: rings left in degrees produced distances near 15.99 and silently
        // raised no problem at all, which reads exactly like "the road fits".
        const graph = buildWith({ parcels: narrowParcel, turf, fit: LaneParcelFit, project });
        expect(graph.problems.some(p => p.type === 'lane_band_exceeds_road_parcel')).toBe(true);
    });
});
