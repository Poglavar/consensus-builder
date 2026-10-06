// "Meridians and parallels" is a Schelling point only if it is a pure function of common knowledge.
//
// So the tests pin the three things a stranger must be able to reproduce: the plan chosen for a
// latitude (round arcsecond steps, whole-degree reference), the parcel geometry (a tiling — all land
// in some parcel, no two overlapping), and the ids (rebuildable from the plan alone). The numbers
// the explainer quotes come from the same functions, so if these hold the explainer is honest.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Grid = require('../../frontend/js/parcels/schelling-grid.js');

const ZAGREB = { lat: 45.8045, lng: 15.9788 };

function bboxOf(feature) {
    const ring = feature.geometry.coordinates[0];
    const xs = ring.map(p => p[0]);
    const ys = ring.map(p => p[1]);
    return { west: Math.min(...xs), south: Math.min(...ys), east: Math.max(...xs), north: Math.max(...ys) };
}

function areaDeg2(box) { return (box.east - box.west) * (box.north - box.south); }

function interiorsOverlap(a, b) {
    const eps = 1e-12;
    return a.west < b.east - eps && b.west < a.east - eps && a.south < b.north - eps && b.south < a.north - eps;
}

describe('the ellipsoid arithmetic', () => {
    it('knows how long a second of arc is', () => {
        expect(Grid.metersPerArcsecondLat(0)).toBeCloseTo(30.715, 2);
        expect(Grid.metersPerArcsecondLat(45)).toBeCloseTo(30.87, 1);
        expect(Grid.metersPerArcsecondLon(0)).toBeCloseTo(30.92, 1);
        expect(Grid.metersPerArcsecondLon(45)).toBeCloseTo(21.9, 1);
        expect(Grid.metersPerArcsecondLon(60)).toBeCloseTo(15.5, 1);
    });

    it('only ever picks a step that divides a degree evenly', () => {
        Grid.ARCSECOND_LADDER.forEach(step => expect(3600 % step).toBe(0));
        expect(Grid.chooseStep(1000, Grid.metersPerArcsecondLat(45))).toBe(30);
        expect(Grid.chooseStep(1000, Grid.metersPerArcsecondLon(45))).toBe(45);
        expect(Grid.chooseStep(1000, Grid.metersPerArcsecondLon(60))).toBe(60);
    });

    it('judges steps by ratio, so 30" (-7%) beats 36" (+11%)', () => {
        // 1000 m at 30.87 m/" wants 32.4": 30 is 7% short, 36 is 11% long.
        expect(Grid.chooseStep(1000, 30.87)).toBe(30);
    });
});

describe('the plan for a place', () => {
    it('is anchored to the whole-degree parallel, so neighbours agree', () => {
        const a = Grid.planFor({ lat: 45.78 });
        const b = Grid.planFor({ lat: 46.21 });
        expect(a.refLat).toBe(46);
        expect(b.refLat).toBe(46);
        expect(a.code).toBe(b.code);
        expect(a.code).toBe('45x30-8x8-30-12@46N');
    });

    it('quotes Angel by default: ~1 km arterials, 30 m wide', () => {
        const plan = Grid.planFor(ZAGREB);
        expect(plan.arterialSpacingM).toBe(1000);
        expect(plan.arterialWidthM).toBe(30);
        expect(plan.arterial.spacingLatM).toBeGreaterThan(900);
        expect(plan.arterial.spacingLatM).toBeLessThan(1100);
        expect(plan.arterial.spacingLonM).toBeGreaterThan(900);
        expect(plan.arterial.spacingLonM).toBeLessThan(1100);
    });

    it('divides the superblock into blocks near the target face', () => {
        const plan = Grid.planFor(ZAGREB);
        expect(plan.subdivision.nLat).toBe(8);
        expect(plan.subdivision.nLon).toBe(8);
        expect(plan.block.widthM).toBeGreaterThan(90);
        expect(plan.block.widthM).toBeLessThan(130);
        expect(plan.block.depthM).toBeGreaterThan(90);
        expect(plan.block.depthM).toBeLessThan(130);
        expect(plan.block.areaM2).toBeCloseTo(plan.block.widthM * plan.block.depthM, 6);
    });

    it('stretches the longitude step as the meridians converge', () => {
        expect(Grid.planFor({ lat: 0 }).arterial.stepLonSec).toBe(30);
        expect(Grid.planFor({ lat: 52 }).arterial.stepLonSec).toBe(60);
        expect(Grid.planFor({ lat: 70 }).arterial.stepLonSec).toBe(90);
    });

    it('names the southern hemisphere in the code', () => {
        expect(Grid.planFor({ lat: -34.6 }).code).toMatch(/@35S$/);
    });

    it('refuses a plan whose streets leave no block', () => {
        expect(() => Grid.planFor({ lat: 45, streetWidthM: 200 })).toThrow(/no room for a block/);
        expect(() => Grid.planFor({ lat: 89 })).toThrow(RangeError);
    });
});

describe('the parcels', () => {
    const plan = Grid.planFor(ZAGREB);
    const box = [15.970, 45.800, 15.985, 45.810];
    const features = Grid.featuresInBbox(plan, box);

    it('come out as closed polygons with ids and provenance, never as cadastre', () => {
        expect(features.length).toBeGreaterThan(100);
        features.forEach(feature => {
            expect(feature.type).toBe('Feature');
            expect(feature.geometry.type).toBe('Polygon');
            const ring = feature.geometry.coordinates[0];
            expect(ring.length).toBe(5);
            expect(ring[0]).toEqual(ring[4]);
            expect(feature.properties.parcelId).toMatch(/^MP:45x30-8x8-30-12@46N:(B|EW|NS):-?\d+:-?\d+$/);
            expect(feature.properties.id).toBe(feature.properties.parcelId);
            expect(feature.properties.parcel_id).toBe(feature.properties.parcelId);
            expect(feature.properties.provenance).toBe('schelling-point');
            expect(feature.properties.estimated).toBe(true);
            expect(feature.properties.area_m2).toBeGreaterThan(0);
        });
    });

    it('marks streets as roads and blocks as not', () => {
        const blocks = features.filter(f => f.properties.kind === 'block');
        const streets = features.filter(f => f.properties.kind === 'street');
        expect(blocks.length).toBeGreaterThan(0);
        expect(streets.length).toBeGreaterThan(0);
        blocks.forEach(f => expect(f.properties.isRoad).toBe(false));
        streets.forEach(f => {
            expect(f.properties.isRoad).toBe(true);
            expect(['arterial', 'local']).toContain(f.properties.roadClass);
        });
        // Every 8th line is an arterial, so arterials are a minority of the streets.
        const arterials = streets.filter(f => f.properties.roadClass === 'arterial');
        expect(arterials.length).toBeGreaterThan(0);
        expect(arterials.length).toBeLessThan(streets.length / 2);
    });

    it('never overlap', () => {
        const boxes = features.map(bboxOf);
        for (let a = 0; a < boxes.length; a += 1) {
            for (let b = a + 1; b < boxes.length; b += 1) {
                if (interiorsOverlap(boxes[a], boxes[b])) {
                    throw new Error(`${features[a].properties.parcelId} overlaps ${features[b].properties.parcelId}`);
                }
            }
        }
    });

    it('cover all the land: the three pieces of a cell add up to the cell tile exactly', () => {
        const byCell = new Map();
        features.forEach(feature => {
            const [, , kind, i, j] = feature.properties.parcelId.split(':');
            const key = `${i}:${j}`;
            if (!byCell.has(key)) byCell.set(key, {});
            byCell.get(key)[kind] = bboxOf(feature);
        });
        let complete = 0;
        byCell.forEach(pieces => {
            if (!pieces.B || !pieces.EW || !pieces.NS) return; // the box edge cut this cell
            complete += 1;
            const tile = {
                west: pieces.EW.west, east: pieces.EW.east,
                south: pieces.EW.south, north: pieces.B.north
            };
            // The north-south street fills the gap between the east-west strip and the block.
            expect(pieces.NS.west).toBeCloseTo(pieces.EW.west, 12);
            expect(pieces.NS.east).toBeCloseTo(pieces.B.west, 12);
            expect(pieces.NS.south).toBeCloseTo(pieces.EW.north, 12);
            expect(pieces.NS.north).toBeCloseTo(pieces.B.north, 12);
            expect(pieces.B.east).toBeCloseTo(pieces.EW.east, 12);
            const sum = areaDeg2(pieces.B) + areaDeg2(pieces.EW) + areaDeg2(pieces.NS);
            expect(sum).toBeCloseTo(areaDeg2(tile), 14);
        });
        expect(complete).toBeGreaterThan(50);
    });

    it('cells chain into a tiling: one cell’s tile ends exactly where the next begins', () => {
        const byId = new Map(features.map(f => [f.properties.parcelId, bboxOf(f)]));
        const some = features.find(f => f.properties.parcelId.includes(':EW:'));
        const [, code, , i, j] = some.properties.parcelId.split(':');
        const here = byId.get(`MP:${code}:EW:${i}:${j}`);
        const eastward = byId.get(`MP:${code}:EW:${Number(i) + 1}:${j}`);
        const northBlock = byId.get(`MP:${code}:B:${i}:${j}`);
        const nextRow = byId.get(`MP:${code}:EW:${i}:${Number(j) + 1}`);
        expect(eastward.west).toBeCloseTo(here.east, 12);
        expect(nextRow.south).toBeCloseTo(northBlock.north, 12);
    });

    it('are identical whichever viewport asked for them', () => {
        const again = Grid.featuresInBbox(plan, [15.978, 45.804, 15.990, 45.815]);
        const byId = new Map(features.map(f => [f.properties.parcelId, f]));
        let shared = 0;
        again.forEach(feature => {
            const twin = byId.get(feature.properties.parcelId);
            if (!twin) return;
            shared += 1;
            expect(feature).toEqual(twin);
        });
        expect(shared).toBeGreaterThan(20);
    });

    it('can be rebuilt from their id alone, and only by their own plan', () => {
        features.slice(0, 40).forEach(feature => {
            expect(Grid.featureForId(plan, feature.properties.parcelId)).toEqual(feature);
        });
        const other = Grid.planFor({ lat: 45.8, streetWidthM: 10 });
        expect(other.code).not.toBe(plan.code);
        expect(Grid.featureForId(other, features[0].properties.parcelId)).toBeNull();
        expect(Grid.featureForId(plan, 'HR-330264-123')).toBeNull();
    });

    it('lie on round arcseconds: arterial edges sit on the ladder step', () => {
        const stepLatDeg = plan.arterial.stepLatSec / 3600;
        const arterialEW = features.find(f => f.properties.parcelId.includes(':EW:') && f.properties.roadClass === 'arterial');
        const centreLat = (bboxOf(arterialEW).south + bboxOf(arterialEW).north) / 2;
        const remainder = Math.abs(centreLat / stepLatDeg - Math.round(centreLat / stepLatDeg));
        expect(remainder).toBeLessThan(1e-9);
    });

    it('refuses to lay out a continent in one request', () => {
        expect(() => Grid.featuresInBbox(plan, [0, 0, 20, 20])).toThrow(RangeError);
        expect(() => Grid.featuresInBbox(plan, [1, 2])).toThrow(TypeError);
    });
});

describe('what the explainer says', () => {
    const plan = Grid.planFor(ZAGREB);

    it('names the nearest arterials in degrees, minutes and seconds', () => {
        const nearest = Grid.nearestArterials(plan, ZAGREB.lat, ZAGREB.lng);
        expect(nearest.latText).toBe('45° 48′ 30″ N');
        expect(nearest.lonText).toBe('15° 58′ 30″ E');
        expect(nearest.latDistanceM).toBeLessThan(plan.arterial.spacingLatM / 2 + 1);
        expect(nearest.lonDistanceM).toBeLessThan(plan.arterial.spacingLonM / 2 + 1);
    });

    it('formats hemispheres and carries over seconds', () => {
        expect(Grid.formatDms(-34.5, 'lat')).toBe('34° 30′ 0″ S');
        expect(Grid.formatDms(-58.999999999, 'lon')).toBe('59° 0′ 0″ W');
        expect(Grid.formatDms(15.975, 'lon')).toBe('15° 58′ 30″ E');
    });

    it('reports the same numbers the geometry uses', () => {
        const d = Grid.describe(plan, ZAGREB);
        expect(d.code).toBe(plan.code);
        expect(d.arterialStepLatSec).toBe(30);
        expect(d.arterialStepLonSec).toBe(45);
        expect(d.nLat).toBe(8);
        expect(d.blocksPerSuperblock).toBe(64);
        expect(d.blockWidthM).toBe(Math.round(plan.block.widthM));
        expect(d.blockAreaHa).toBeCloseTo(plan.block.areaM2 / 10000, 1);
        expect(d.nearest.latText).toBe('45° 48′ 30″ N');
        expect(Grid.describe(plan).nearest).toBeUndefined();
    });
});
