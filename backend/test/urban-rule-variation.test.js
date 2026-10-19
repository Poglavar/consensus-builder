// Unit tests for frontend/js/urban-rule-variation.js — the permitted-massing / example-build-out
// split. Three properties matter and all three were broken before this module existed:
//   1. the same (rule, seed) reproduces the same building — generation ran on unseeded
//      Math.random(), so a reload, a shared link and a thumbnail each showed a different city;
//   2. the envelope does NOT depend on the seed — the € gain reads the envelope, so re-rolling a
//      variation must never move a proposal's money number (clicking Regenerate used to);
//   3. a missing parameter does not become a real one — Number(null) is 0, which would silently
//      turn an absent setback into "build to the boundary".
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const V = require('../../frontend/js/urban-rule-variation.js');

const deps = { turf };

// A rectangle of the given size in metres, centred near Zagreb. Latitude matters: a degree of
// longitude there is ~70% of a degree of latitude, so a naive square in degrees is not a square.
function parcel(widthM = 40, heightM = 40, lat = 45.8, lng = 15.98) {
    const dLat = (heightM / 2) / 110540;
    const dLng = (widthM / 2) / (111320 * Math.cos(lat * Math.PI / 180));
    const ring = [
        [lng - dLng, lat - dLat],
        [lng + dLng, lat - dLat],
        [lng + dLng, lat + dLat],
        [lng - dLng, lat + dLat],
        [lng - dLng, lat - dLat]
    ];
    return turf.polygon([ring]);
}

const RULE = { minDistance: 3, maxFloors: 5, floorHeightM: 3 };

describe('deterministic randomness', () => {
    it('hashSeed is stable and separates its parts', () => {
        expect(V.hashSeed('a', 'b')).toBe(V.hashSeed('a', 'b'));
        expect(V.hashSeed('a', 'b')).not.toBe(V.hashSeed('b', 'a'));
        expect(V.hashSeed('ab', '')).not.toBe(V.hashSeed('a', 'b'));
        expect(V.hashSeed('x')).toBeGreaterThanOrEqual(0);
    });

    it('mulberry32 replays the same stream and stays in [0,1)', () => {
        const a = V.mulberry32(12345);
        const b = V.mulberry32(12345);
        const drawn = [];
        for (let i = 0; i < 50; i++) {
            const value = a();
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThan(1);
            drawn.push(value);
        }
        expect(drawn.map(() => b())).toEqual(drawn);
        expect(V.mulberry32(12346)()).not.toBe(drawn[0]);
    });

    it('hashIndex keeps a key on the same palette entry', () => {
        expect(V.hashIndex('parcel-7', 15)).toBe(V.hashIndex('parcel-7', 15));
        expect(V.hashIndex('parcel-7', 15)).toBeLessThan(15);
        expect(V.hashIndex('anything', 0)).toBe(0);
    });
});

describe('normalizeParcelRule', () => {
    it('does not turn a missing value into a real one (Number(null) === 0)', () => {
        const rule = V.normalizeParcelRule({ minDistance: null, maxFloors: undefined, floorHeightM: '' });
        expect(rule.minDistance).toBe(V.DEFAULT_MIN_DISTANCE_M);
        expect(rule.maxFloors).toBe(V.DEFAULT_MAX_FLOORS);
        expect(rule.floorHeightM).toBe(V.DEFAULT_FLOOR_HEIGHT_M);
    });

    it('reads numeric strings but rejects junk', () => {
        expect(V.normalizeParcelRule({ minDistance: '4.5' }).minDistance).toBe(4.5);
        expect(V.normalizeParcelRule({ minDistance: 'wide' }).minDistance).toBe(V.DEFAULT_MIN_DISTANCE_M);
    });

    it('clamps a negative setback and a below-one floor count', () => {
        const rule = V.normalizeParcelRule({ minDistance: -5, maxFloors: 0 });
        expect(rule.minDistance).toBe(0);
        expect(rule.maxFloors).toBe(1);
    });

    it('kind "exact" (C) pins the minimum to the maximum', () => {
        const rule = V.normalizeParcelRule({ kind: 'exact', maxFloors: 6, minFloors: 2 });
        expect(rule.minFloors).toBe(6);
    });

    it('a minimum above the maximum is clamped, and an unknown kind falls back to max-only', () => {
        expect(V.normalizeParcelRule({ maxFloors: 4, minFloors: 9 }).minFloors).toBe(4);
        expect(V.normalizeParcelRule({ kind: 'whatever' }).kind).toBe('max');
    });
});

describe('parcelEnvelope', () => {
    it('sets the parcel back and extrudes to the maximum floors', () => {
        const envelope = V.parcelEnvelope(parcel(40, 40), RULE, deps);
        expect(envelope).toBeTruthy();
        expect(envelope.properties.height).toBe(15); // 5 floors x 3 m
        expect(envelope.properties.floors).toBe(5);
        expect(envelope.properties.massing).toBe(true);
        // 40x40 set back 3 m on every side is ~34x34.
        expect(turf.area(envelope)).toBeGreaterThan(1000);
        expect(turf.area(envelope)).toBeLessThan(1300);
    });

    it('excludes a parcel below the minimum plot size', () => {
        const small = parcel(6, 6); // 36 m²
        expect(V.parcelEnvelope(small, { ...RULE, minDistance: 0, minPlotAreaM2: 0 }, deps)).toBeTruthy();
        expect(V.parcelEnvelope(small, { ...RULE, minDistance: 0, minPlotAreaM2: 50 }, deps)).toBeNull();
    });

    it('returns null when the setback consumes the parcel', () => {
        expect(V.parcelEnvelope(parcel(4, 4), { ...RULE, minDistance: 3 }, deps)).toBeNull();
    });

    it('is independent of the seed — re-rolling a variation cannot move the stats', () => {
        const p = parcel(40, 40);
        const envelope = V.parcelEnvelope(p, RULE, deps);
        const areas = new Set();
        for (let seed = 0; seed < 25; seed++) {
            V.realizeFromEnvelope(envelope, RULE, seed, deps); // whatever the build-out does…
            areas.add(Math.round(turf.area(V.parcelEnvelope(p, RULE, deps)) * 1000));
        }
        expect(areas.size).toBe(1); // …the permitted volume never budges
    });
});

describe('evaluateParcel — why a parcel is excluded', () => {
    it('reports a buildable parcel as ok', () => {
        const result = V.evaluateParcel(parcel(40, 40), RULE, deps);
        expect(result.status).toBe('ok');
        expect(result.envelope).toBeTruthy();
    });

    it('separates below-min-plot from no-room-after-setback', () => {
        // 36 m² plot: excluded by a 50 m² minimum plot rule, whatever the setback does.
        expect(V.evaluateParcel(parcel(6, 6), { ...RULE, minDistance: 0, minPlotAreaM2: 50 }, deps).status)
            .toBe('below-min-plot');
        // Big enough to be a plot, but the setback leaves nothing.
        expect(V.evaluateParcel(parcel(5, 5), { ...RULE, minDistance: 3, minPlotAreaM2: 10 }, deps).status)
            .toBe('no-room-after-setback');
    });

    it('flags a rule that contradicts itself on a plot it otherwise allows', () => {
        // 40x40 set back 3 m leaves ~1,150 m². Compelling a 2,000 m² ground floor cannot be met —
        // a fault in the rule, not in the plot, and distinct from "too small to build on".
        const rule = { ...RULE, kind: 'range', minFootprintAreaM2: 2000 };
        expect(V.evaluateParcel(parcel(40, 40), rule, deps).status).toBe('cannot-meet-minimum');
        expect(V.evaluateParcel(parcel(40, 40), { ...rule, minFootprintAreaM2: 400 }, deps).status).toBe('ok');
    });

    it('only a range rule carries a compelled minimum footprint', () => {
        // A stray value under 'max' or 'exact' would exclude parcels the rule does not exclude.
        for (const kind of ['max', 'exact']) {
            const rule = V.normalizeParcelRule({ ...RULE, kind, minFootprintAreaM2: 2000 });
            expect(rule.minFootprintAreaM2).toBe(0);
            expect(V.evaluateParcel(parcel(40, 40), rule, deps).status).toBe('ok');
        }
    });
});

describe('realizeFromEnvelope', () => {
    const envelope = V.parcelEnvelope(parcel(40, 40), RULE, deps);

    it('replays exactly from the same seed (the reload / shared-link property)', () => {
        const a = V.realizeFromEnvelope(envelope, RULE, 4242, deps);
        const b = V.realizeFromEnvelope(envelope, RULE, 4242, deps);
        expect(b.geometry).toEqual(a.geometry);
        expect(b.properties.floors).toBe(a.properties.floors);
    });

    it('actually varies: different seeds give different footprints and floor counts', () => {
        const footprints = new Set();
        const floors = new Set();
        for (let seed = 0; seed < 40; seed++) {
            const built = V.realizeFromEnvelope(envelope, RULE, seed, deps);
            footprints.add(JSON.stringify(built.geometry));
            floors.add(built.properties.floors);
        }
        expect(footprints.size).toBeGreaterThan(10);
        expect(floors.size).toBeGreaterThan(1);
    });

    it('never exceeds the envelope, and never leaves a building with no floors', () => {
        const permitted = turf.area(envelope);
        for (let seed = 0; seed < 40; seed++) {
            const built = V.realizeFromEnvelope(envelope, RULE, seed, deps);
            expect(turf.area(built)).toBeLessThanOrEqual(permitted + 1e-6);
            expect(built.properties.floors).toBeGreaterThanOrEqual(1);
            expect(built.properties.floors).toBeLessThanOrEqual(RULE.maxFloors);
            expect(built.properties.height).toBe(built.properties.floors * RULE.floorHeightM);
            expect(built.properties.massing).toBe(false);
        }
    });

    it('honours a minimum floor count (type B)', () => {
        for (let seed = 0; seed < 30; seed++) {
            const built = V.realizeFromEnvelope(envelope, { ...RULE, kind: 'range', minFloors: 4 }, seed, deps);
            expect(built.properties.floors).toBeGreaterThanOrEqual(4);
            expect(built.properties.floors).toBeLessThanOrEqual(5);
        }
    });

    it('honours a compelled minimum ground floor (type B)', () => {
        const rule = { ...RULE, kind: 'range', minFootprintAreaM2: 600 };
        let varied = 0;
        for (let seed = 0; seed < 40; seed++) {
            const built = V.realizeFromEnvelope(envelope, rule, seed, deps);
            expect(turf.area(built)).toBeGreaterThanOrEqual(600 - 1e-6);
            if (turf.area(built) < turf.area(envelope) - 1) varied++;
        }
        // The minimum must constrain the variation, not abolish it — always filling the envelope
        // would make every B rule look like a C rule.
        expect(varied).toBeGreaterThan(5);
    });

    it('type C returns the envelope itself — nothing to vary, so callers can draw it once', () => {
        const built = V.realizeFromEnvelope(envelope, { ...RULE, kind: 'exact' }, 7, deps);
        expect(built).toBe(envelope);
    });

    it('draws the floor count off the seed alone, not off the parcel shape', () => {
        // Pins the draw order: floors first, then the footprint. Inserting a draw ahead of the
        // floor count would silently restyle every design ever shared.
        const wide = V.parcelEnvelope(parcel(80, 25), RULE, deps);
        const tall = V.parcelEnvelope(parcel(25, 80), RULE, deps);
        for (let seed = 0; seed < 20; seed++) {
            expect(V.realizeFromEnvelope(wide, RULE, seed, deps).properties.floors)
                .toBe(V.realizeFromEnvelope(tall, RULE, seed, deps).properties.floors);
        }
    });
});

describe('realizeFeature', () => {
    it('reads the rule and seed stamped on the feature', () => {
        const envelope = V.parcelEnvelope(parcel(40, 40), RULE, deps);
        envelope.properties.urbanRule = V.normalizeParcelRule(RULE);
        envelope.properties.variationSeed = 99;
        const built = V.realizeFeature(envelope, deps);
        expect(built.properties.massing).toBe(false);
        expect(built.geometry).toEqual(V.realizeFromEnvelope(envelope, RULE, 99, deps).geometry);
    });

    it('a salt re-rolls without touching the stored seed', () => {
        const envelope = V.parcelEnvelope(parcel(40, 40), RULE, deps);
        envelope.properties.urbanRule = V.normalizeParcelRule(RULE);
        envelope.properties.variationSeed = 99;
        const plain = V.realizeFeature(envelope, deps);
        const salted = V.realizeFeature(envelope, deps, 'session-3');
        expect(V.realizeFeature(envelope, deps, 'session-3').geometry).toEqual(salted.geometry);
        expect(envelope.properties.variationSeed).toBe(99);
        // A salt that changed nothing would make the 3D view's Randomize a no-op.
        const salts = new Set();
        for (let i = 0; i < 20; i++) salts.add(JSON.stringify(V.realizeFeature(envelope, deps, `s${i}`).geometry));
        expect(salts.size).toBeGreaterThan(5);
        expect(salts.has(JSON.stringify(plain.geometry))).toBe(false);
    });

    it('returns a feature with no rule unchanged — it renders as itself in every view', () => {
        const plain = turf.polygon(parcel(20, 20).geometry.coordinates, { height: 12 });
        expect(V.realizeFeature(plain, deps)).toBe(plain);
        const seedless = V.parcelEnvelope(parcel(40, 40), RULE, deps);
        seedless.properties.urbanRule = V.normalizeParcelRule(RULE);
        expect(V.realizeFeature(seedless, deps)).toBe(seedless); // no seed stamped
    });
});

describe('splitMassingByParcels — a block is a street, not one extruded ring', () => {
    // Four 20 m-wide plots in a row, 40 m deep, with a 12 m-deep building band across their fronts.
    const LAT = 45.8, LNG = 15.98;
    const dLng = m => m / (111320 * Math.cos(LAT * Math.PI / 180));
    const dLat = m => m / 110540;

    function plotAt(offsetM, widthM = 20, depthM = 40) {
        const x0 = LNG + dLng(offsetM), x1 = LNG + dLng(offsetM + widthM);
        const y0 = LAT, y1 = LAT + dLat(depthM);
        return turf.polygon([[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]);
    }

    // A band across the front of the first four plots (0..80 m wide, 12 m deep).
    const band = turf.polygon([[
        [LNG, LAT], [LNG + dLng(80), LAT],
        [LNG + dLng(80), LAT + dLat(12)], [LNG, LAT + dLat(12)], [LNG, LAT]
    ]], { height: 17.5 });

    const parcels = [0, 20, 40, 60].map((o, i) => ({ feature: plotAt(o), parcelId: `p${i}` }));
    const RULE_BLOCK = { typology: 'block', maxHeightM: 17.5, floorHeightM: 3.5 };

    it('cuts one building per parcel, each carrying its own id, shade and seed', () => {
        const { pieces, excluded } = V.splitMassingByParcels(band, parcels, RULE_BLOCK, 11, deps);
        expect(pieces.length).toBe(4);
        expect(excluded.length).toBe(0);
        expect(pieces.map(p => p.properties.parcelId)).toEqual(['p0', 'p1', 'p2', 'p3']);
        expect(new Set(pieces.map(p => p.properties.variationSeed)).size).toBe(4);
        // Shades must actually differ, or the split is invisible.
        expect(new Set(pieces.map(p => p.properties.color)).size).toBeGreaterThan(1);
        // The pieces tile the band: no area invented, none lost.
        const total = pieces.reduce((sum, p) => sum + turf.area(p), 0);
        expect(total).toBeGreaterThan(turf.area(band) * 0.99);
        expect(total).toBeLessThan(turf.area(band) * 1.01);
    });

    it('drops an unbuildable splinter rather than drawing it', () => {
        // A plot catching 0.5 m of the band's end: ~6 m², under the 20 m² piece minimum.
        const splinter = { feature: plotAt(79.5, 5), parcelId: 'splinter' };
        const { pieces, excluded } = V.splitMassingByParcels(band, parcels.concat([splinter]), RULE_BLOCK, 11, deps);
        expect(pieces.some(p => p.properties.parcelId === 'splinter')).toBe(false);
        expect(excluded.find(e => e.parcelId === 'splinter').status).toBe('sliver');
    });

    it('separates a parcel the massing never reaches from one the rule excludes', () => {
        const behind = { feature: plotAt(0, 20, 40), parcelId: 'behind' };
        // Shift it entirely behind the band.
        behind.feature.geometry.coordinates[0] = behind.feature.geometry.coordinates[0]
            .map(([x, y]) => [x, y + dLat(20)]);
        const tiny = { feature: plotAt(100, 4, 4), parcelId: 'tiny' };
        const rule = { ...RULE_BLOCK, minPlotAreaM2: 50 };
        const { excluded } = V.splitMassingByParcels(band, [behind, tiny], rule, 11, deps);
        expect(excluded.find(e => e.parcelId === 'behind').status).toBe('no-massing-here');
        expect(excluded.find(e => e.parcelId === 'tiny').status).toBe('below-min-plot');
    });

    it('varies height per parcel in whole storeys, never above the envelope', () => {
        const { pieces } = V.splitMassingByParcels(band, parcels, RULE_BLOCK, 11, deps);
        const heights = new Set();
        pieces.forEach(piece => {
            for (let salt = 0; salt < 12; salt++) {
                const built = V.realizeFeature(piece, deps, `s${salt}`);
                expect(built.properties.height).toBeLessThanOrEqual(17.5 + 1e-9);
                expect(built.properties.height % 3.5).toBeCloseTo(0, 6);
                expect(built.geometry).toEqual(piece.geometry); // footprint is fixed by the parcel
                heights.add(built.properties.height);
            }
        });
        expect(heights.size).toBeGreaterThan(1);
    });

    it('a range rule holds every building at or above its minimum', () => {
        const rule = { ...RULE_BLOCK, kind: 'range', minHeightM: 10.5 };
        const { pieces } = V.splitMassingByParcels(band, parcels, rule, 11, deps);
        for (const piece of pieces) {
            for (let salt = 0; salt < 12; salt++) {
                const built = V.realizeFeature(piece, deps, `s${salt}`);
                expect(built.properties.height).toBeGreaterThanOrEqual(10.5);
            }
        }
    });

    // A perimeter block: a 80x40 m outer solid with a 60x20 m courtyard punched out, leaving a
    // ~10 m deep ring. The outer boundary is the street frontage.
    const ring = turf.polygon([
        [[LNG, LAT], [LNG + dLng(80), LAT], [LNG + dLng(80), LAT + dLat(40)], [LNG, LAT + dLat(40)], [LNG, LAT]],
        [[LNG + dLng(10), LAT + dLat(10)], [LNG + dLng(10), LAT + dLat(30)],
        [LNG + dLng(70), LAT + dLat(30)], [LNG + dLng(70), LAT + dLat(10)], [LNG + dLng(10), LAT + dLat(10)]]
    ], { height: 17.5 });

    describe('buildToMinimum — the mandatory building line', () => {
        it('takes a band inward from the street, not from the courtyard', () => {
            const compelled = V.buildToMinimum(ring, 4, deps);
            expect(compelled).toBeTruthy();
            // Inside the ring, and a real fraction of it — a 4 m band of a ~10 m ring.
            expect(turf.area(compelled)).toBeLessThan(turf.area(ring));
            expect(turf.area(compelled)).toBeGreaterThan(turf.area(ring) * 0.25);
            // The whole compelled band lies within the massing: containment by construction.
            expect(turf.area(turf.difference(compelled, ring) || turf.polygon([[[0, 0], [0, 1e-9], [1e-9, 0], [0, 0]]])))
                .toBeLessThan(1);
            // It must touch the street: a point 1 m in from the outer edge is compelled…
            expect(turf.booleanPointInPolygon(turf.point([LNG + dLng(40), LAT + dLat(1)]), compelled)).toBe(true);
            // …while a point 1 m outside the courtyard wall (8 m in, deeper than the 4 m band) is not.
            expect(turf.booleanPointInPolygon(turf.point([LNG + dLng(40), LAT + dLat(8)]), compelled)).toBe(false);
        });

        it('compels the whole massing when the ring is thinner than the depth asked for', () => {
            const compelled = V.buildToMinimum(ring, 40, deps);
            expect(turf.area(compelled)).toBeCloseTo(turf.area(ring), 0);
        });

        it('compels nothing without a depth', () => {
            expect(V.buildToMinimum(ring, 0, deps)).toBeNull();
        });
    });

    describe('the compelled minimum through the split and the build-out', () => {
        const RANGE = { typology: 'block', kind: 'range', maxHeightM: 17.5, minHeightM: 7, minDepthM: 4, floorHeightM: 3.5 };
        const ringParcels = [0, 20, 40, 60].map((o, i) => ({ feature: plotAt(o, 20, 40), parcelId: `r${i}` }));

        it('stores each plot its own compelled part, inside its own building', () => {
            const { pieces } = V.splitMassingByParcels(ring, ringParcels, RANGE, 5, deps);
            expect(pieces.length).toBe(4);
            pieces.forEach(piece => {
                const compelled = piece.properties.minFootprint;
                expect(compelled).toBeTruthy();
                const compelledFeature = { type: 'Feature', properties: {}, geometry: compelled };
                expect(turf.area(compelledFeature)).toBeLessThanOrEqual(turf.area(piece) + 1e-6);
            });
        });

        it('a build-out either fills the plot or builds to the line — never less', () => {
            const { pieces } = V.splitMassingByParcels(ring, ringParcels, RANGE, 5, deps);
            const shapes = new Set();
            pieces.forEach(piece => {
                const compelledArea = turf.area({ type: 'Feature', properties: {}, geometry: piece.properties.minFootprint });
                for (let salt = 0; salt < 12; salt++) {
                    const built = V.realizeFeature(piece, deps, `s${salt}`);
                    expect(turf.area(built)).toBeGreaterThanOrEqual(compelledArea - 1e-6);
                    expect(turf.area(built)).toBeLessThanOrEqual(turf.area(piece) + 1e-6);
                    expect(built.properties.height).toBeGreaterThanOrEqual(7);
                    shapes.add(built.properties.builtToMinimumDepth);
                }
            });
            // Both depths must actually occur, or the build-to line changed nothing visible.
            expect(shapes.has(true)).toBe(true);
            expect(shapes.has(false)).toBe(true);
        });

        it('no minimum is stored, and none is compelled, unless the rule is a range', () => {
            for (const kind of ['max', 'exact']) {
                const { pieces } = V.splitMassingByParcels(ring, ringParcels, { ...RANGE, kind }, 5, deps);
                pieces.forEach(piece => expect(piece.properties.minFootprint).toBeUndefined());
            }
        });

        it('a row never gets a build-to line — its back faces gardens, not a street', () => {
            const rowRule = { ...RANGE, typology: 'row' };
            expect(V.normalizeBlockRule(rowRule).minDepthM).toBe(0);
        });

        it('reports the permitted ceiling and the guaranteed floor as a range', () => {
            const { pieces } = V.splitMassingByParcels(ring, ringParcels, RANGE, 5, deps);
            const range = V.summariseBlockRule(pieces, RANGE, deps);
            expect(range.guaranteedFloorAreaM2).toBeGreaterThan(0);
            expect(range.guaranteedFloorAreaM2).toBeLessThan(range.permittedFloorAreaM2);

            // 'max' compels nothing; 'exact' delivers exactly what it permits.
            const maxRule = { ...RANGE, kind: 'max' };
            const maxPieces = V.splitMassingByParcels(ring, ringParcels, maxRule, 5, deps).pieces;
            expect(V.summariseBlockRule(maxPieces, maxRule, deps).guaranteedFloorAreaM2).toBe(0);

            const exactRule = { ...RANGE, kind: 'exact' };
            const exactPieces = V.splitMassingByParcels(ring, ringParcels, exactRule, 5, deps).pieces;
            const exact = V.summariseBlockRule(exactPieces, exactRule, deps);
            expect(exact.guaranteedFloorAreaM2).toBeCloseTo(exact.permittedFloorAreaM2, 6);
        });
    });

    it('an exact rule leaves the piece untouched, so it draws once', () => {
        const { pieces } = V.splitMassingByParcels(band, parcels, { ...RULE_BLOCK, kind: 'exact' }, 11, deps);
        const plan = V.plannedDrawPlan(pieces[0], 'both', deps, '');
        expect(plan.buildOut).toBe(pieces[0]);
        expect(plan.massing).toBeNull();
    });
});

describe('plannedDrawPlan', () => {
    function ruled(kind = 'max') {
        const envelope = V.parcelEnvelope(parcel(40, 40), { ...RULE, kind }, deps);
        envelope.properties.urbanRule = V.normalizeParcelRule({ ...RULE, kind });
        envelope.properties.variationSeed = 7;
        return envelope;
    }

    it('massing draws the envelope alone, as the proposal itself', () => {
        const envelope = ruled();
        const plan = V.plannedDrawPlan(envelope, 'massing', deps, '');
        expect(plan.buildOut).toBeNull();
        expect(plan.massing).toBe(envelope);
        expect(plan.massingStyle).toBe('primary');
    });

    it('buildout draws only the example', () => {
        const envelope = ruled();
        const plan = V.plannedDrawPlan(envelope, 'buildout', deps, '');
        expect(plan.massing).toBeNull();
        expect(plan.buildOut).not.toBe(envelope);
        expect(plan.buildOut.properties.massing).toBe(false);
    });

    it('both draws the example inside a translucent envelope', () => {
        const envelope = ruled();
        const plan = V.plannedDrawPlan(envelope, 'both', deps, '');
        expect(plan.buildOut).not.toBe(envelope);
        expect(plan.massing).toBe(envelope);
        expect(plan.massingStyle).toBe('envelope');
    });

    it('never returns two coincident volumes when there is nothing to vary', () => {
        // A feature with no rule, and a build-exactly (C) rule: in both the build-out IS the
        // massing, so drawing both would z-fight against itself.
        const plain = turf.polygon(parcel(20, 20).geometry.coordinates, { height: 12 });
        for (const representation of ['massing', 'buildout', 'both']) {
            for (const feature of [plain, ruled('exact')]) {
                const plan = V.plannedDrawPlan(feature, representation, deps, '');
                const drawn = [plan.buildOut, plan.massing].filter(Boolean);
                expect(drawn.length).toBe(1);
                expect(drawn[0]).toBe(feature);
            }
        }
    });

    it('passes the salt through, so a view can re-roll without touching stored data', () => {
        const envelope = ruled();
        const a = V.plannedDrawPlan(envelope, 'both', deps, 'salt-a').buildOut;
        const b = V.plannedDrawPlan(envelope, 'both', deps, 'salt-b').buildOut;
        expect(JSON.stringify(a.geometry)).not.toBe(JSON.stringify(b.geometry));
        expect(envelope.properties.variationSeed).toBe(7);
    });
});
