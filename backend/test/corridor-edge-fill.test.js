// Unit tests for the corridor edge-fill module: the band (pure planar), the per-parcel building
// line (pure planar), and the region (turf, lat/lng). The scene most tests share is a 100 m straight
// road heading east, with a block of parcels along its north side.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const {
    corridorEdgeFillBandOffsets,
    corridorEdgeFillBandRing,
    projectPointOntoPolyline,
    corridorEdgeFillBuildingLineOffset,
    corridorEdgeFillParcelCuts,
    corridorEdgeFillRegion,
    corridorEdgeFillSides
} = require('../../frontend/js/corridor-edge-fill.js');

// A 100 m straight road heading east; travel direction +x, so left is +y (north).
const CENTERLINE = [[0, 0], [100, 0]];
const ringOf = (x1, x2, y1, y2) => [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];

describe('corridorEdgeFillBandOffsets', () => {
    it('offers the full reach along a road welded to nothing', () => {
        const offsets = corridorEdgeFillBandOffsets(CENTERLINE, { minOffset: 3, maxOffset: 12 });
        expect(offsets).toEqual([12, 12]);
    });

    it('eases back to the drawn width at a welded end', () => {
        const dense = [[0, 0], [10, 0], [20, 0], [30, 0], [40, 0]];
        const offsets = corridorEdgeFillBandOffsets(dense, {
            minOffset: 3, maxOffset: 12, taperStart: true, taperEnd: true, taperMeters: 20
        });
        expect(offsets[0]).toBeCloseTo(3, 6);
        expect(offsets[offsets.length - 1]).toBeCloseTo(3, 6);
        expect(offsets[2]).toBeGreaterThan(offsets[1]); // rising toward the middle
    });

    it('refuses a band with no drawn width to grow from', () => {
        expect(corridorEdgeFillBandOffsets(CENTERLINE, {})).toBeNull();
        expect(corridorEdgeFillBandOffsets([[0, 0]], { minOffset: 3 })).toBeNull();
    });
});

describe('corridorEdgeFillBandRing', () => {
    it('spans from the shared seam out to the reach, on the named side', () => {
        const left = corridorEdgeFillBandRing(CENTERLINE, 1, { side: 'left', minOffset: 3, maxOffset: 9 });
        const leftYs = left.map(([, y]) => y);
        expect(Math.max(...leftYs)).toBeCloseTo(9, 6);
        expect(Math.min(...leftYs)).toBeCloseTo(1, 6);

        const right = corridorEdgeFillBandRing(CENTERLINE, -1, { side: 'right', minOffset: 3, maxOffset: 9 });
        const rightYs = right.map(([, y]) => y);
        expect(Math.min(...rightYs)).toBeCloseTo(-9, 6);
        expect(Math.max(...rightYs)).toBeCloseTo(-1, 6);
    });
});

describe('projectPointOntoPolyline', () => {
    it('signs the side by the direction of travel', () => {
        expect(projectPointOntoPolyline(CENTERLINE, [50, 7]).signed).toBeCloseTo(7, 6);
        expect(projectPointOntoPolyline(CENTERLINE, [50, -7]).signed).toBeCloseTo(-7, 6);
    });

    it('knows what is beside the road and what is past its end', () => {
        expect(projectPointOntoPolyline(CENTERLINE, [50, 7]).abreast).toBe(true);
        expect(projectPointOntoPolyline(CENTERLINE, [120, 7]).abreast).toBe(false);
        expect(projectPointOntoPolyline(CENTERLINE, [-20, 7]).abreast).toBe(false);
    });
});

describe('corridorEdgeFillBuildingLineOffset', () => {
    const options = { minOffset: 3, maxOffset: 20 };

    it('takes the closest the building comes to the road', () => {
        expect(corridorEdgeFillBuildingLineOffset(CENTERLINE, [ringOf(5, 45, 6, 20)], 'left', options)).toBeCloseTo(6, 6);
    });

    it('ignores a building on the other side', () => {
        expect(corridorEdgeFillBuildingLineOffset(CENTERLINE, [ringOf(5, 45, -20, -6)], 'left', options)).toBeNull();
        expect(corridorEdgeFillBuildingLineOffset(CENTERLINE, [ringOf(5, 45, -20, -6)], 'right', options)).toBeCloseTo(6, 6);
    });

    it('ignores a building that is past the road rather than beside it', () => {
        expect(corridorEdgeFillBuildingLineOffset(CENTERLINE, [ringOf(130, 170, 6, 20)], 'left', options)).toBeNull();
    });

    it('never pulls the line inside the drawn width', () => {
        // A building the road already reaches into: the overlap is a collision, not a narrower lane.
        expect(corridorEdgeFillBuildingLineOffset(CENTERLINE, [ringOf(5, 45, 1.5, 20)], 'left', options)).toBeCloseTo(3, 6);
    });

    it('never reaches past the bound', () => {
        expect(corridorEdgeFillBuildingLineOffset(CENTERLINE, [ringOf(5, 45, 40, 60)], 'left', options)).toBeCloseTo(20, 6);
    });
});

// ---------------------------------------------------------------------------
// The region. Rectangles are built in metres around a Zagreb-ish origin and converted to lat/lng,
// because turf.area (the sliver and connectivity thresholds) reads the real frame.
// ---------------------------------------------------------------------------
const ORIGIN = [15.97, 45.8];
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LNG = 111320 * Math.cos(ORIGIN[1] * Math.PI / 180);
const toLngLat = ([x, y]) => [ORIGIN[0] + x / M_PER_DEG_LNG, ORIGIN[1] + y / M_PER_DEG_LAT];
const polygon = points => turf.polygon([[...points, points[0]].map(toLngLat)]);
const rect = (x1, x2, y1, y2) => polygon(ringOf(x1, x2, y1, y2));
const hasVertex = (feature, [x, y]) => {
    const [lng, lat] = toLngLat([x, y]);
    return turf.coordAll(feature).some(([a, b]) => Math.abs(a - lng) < 1e-9 && Math.abs(b - lat) < 1e-9);
};
const deepestReach = feature => Math.max(...turf.coordAll(feature).map(([, lat]) => (lat - ORIGIN[1]) * M_PER_DEG_LAT));

// The lane may reach 20 m; it is guaranteed 3 m, from a seam at 1 m.
const BAND = rect(0, 100, 1, 20);
const NOMINAL = rect(0, 100, 1, 3);

describe('corridorEdgeFillRegion', () => {
    it('takes a cut whole, corners and all', () => {
        // A road parcel that steps out halfway along, the way a real one does.
        const roadParcel = polygon([[0, 1], [100, 1], [100, 4], [50, 4], [50, 6], [0, 6]]);
        const region = corridorEdgeFillRegion(BAND, NOMINAL, [roadParcel], { turf });
        expect(hasVertex(region, [50, 6])).toBe(true);
        expect(turf.area(region)).toBeCloseTo(50 * 5 + 50 * 3, 0);
    });

    it('keeps the drawn width when there is nothing to take', () => {
        expect(turf.area(corridorEdgeFillRegion(BAND, NOMINAL, [], { turf }))).toBeCloseTo(200, 0);
    });

    it('drops a cut the kerb does not connect to', () => {
        const acrossTheStreet = rect(0, 100, 10, 16);
        const region = corridorEdgeFillRegion(BAND, NOMINAL, [acrossTheStreet], { turf });
        expect(turf.area(region)).toBeCloseTo(200, 0); // nominal only
    });

    it('never reaches past the band', () => {
        const region = corridorEdgeFillRegion(BAND, NOMINAL, [rect(0, 100, 1, 60)], { turf });
        expect(deepestReach(region)).toBeCloseTo(20, 6);
    });

    // The acceptance case: this is what the sampled fill got wrong on a real block.
    it('steps at the property line and never bulges into the gap between two buildings', () => {
        // Two parcels side by side, each with one building, 10 m of open ground between them.
        const parcels = [
            { feature: rect(0, 50, 0, 30), rings: [ringOf(5, 45, 6, 20)] },
            { feature: rect(50, 100, 0, 30), rings: [ringOf(55, 95, 4, 18)] }
        ];
        // Stands in for the editor's projected strip builder: the frontage out to `offset`, from
        // the lane's inner seam, along the whole road.
        const buildStrip = offset => rect(0, 100, 1, offset);
        const cuts = corridorEdgeFillParcelCuts(CENTERLINE, parcels, 'left', { turf, minOffset: 3, maxOffset: 20 }, buildStrip);

        const region = corridorEdgeFillRegion(BAND, NOMINAL, cuts, { turf });
        // One line per parcel: 50 m at 6 m deep, 50 m at 4 m deep, measured from the 1 m seam.
        expect(turf.area(region)).toBeCloseTo(50 * 5 + 50 * 3, 0);
        expect(hasVertex(region, [50, 6])).toBe(true); // the step, exactly at the property line
        expect(hasVertex(region, [50, 4])).toBe(true);
        // And nothing reaches past the deeper of the two lines — no bulge into the gap between
        // the buildings, which is where the open ground is and where the old fill ballooned.
        expect(deepestReach(region)).toBeCloseTo(6, 6);
    });

    it('passes over a parcel with nothing built on it rather than guessing a line for it', () => {
        const parcels = [
            { feature: rect(0, 50, 0, 30), rings: [ringOf(5, 45, 6, 20)] },
            { feature: rect(50, 100, 0, 30), rings: [] } // empty lot
        ];
        const cuts = corridorEdgeFillParcelCuts(CENTERLINE, parcels, 'left', { turf, minOffset: 3, maxOffset: 20 },
            offset => rect(0, 100, 1, offset));
        expect(cuts.length).toBe(1);
        const region = corridorEdgeFillRegion(BAND, NOMINAL, cuts, { turf });
        expect(turf.area(region)).toBeCloseTo(50 * 5 + 50 * 2, 0); // filled, then back to the drawn width
    });
});

describe('corridorEdgeFillSides', () => {
    const sidewalk = width => ({ type: 'sidewalk', width });
    const driving = width => ({ type: 'driving', width });

    it('fills both sides of a street that ends in a footway', () => {
        const sides = corridorEdgeFillSides({ strips: [sidewalk(2), driving(3), driving(3), sidewalk(2)] });
        expect(sides.left).toMatchObject({ index: 0, type: 'sidewalk', minOffset: 5, innerOffset: 3 });
        expect(sides.right).toMatchObject({ index: 3, type: 'sidewalk', minOffset: 5, innerOffset: -3 });
    });

    it('leaves a side alone when its outermost lane is not a footway', () => {
        const sides = corridorEdgeFillSides({ strips: [{ type: 'verge', width: 1.5 }, sidewalk(2), driving(3), sidewalk(2)] });
        expect(sides.left).toBeNull();
        expect(sides.right).not.toBeNull();
    });

    it('has nothing to fill on a profile with no lanes', () => {
        expect(corridorEdgeFillSides(null)).toEqual({ left: null, right: null });
    });
});
