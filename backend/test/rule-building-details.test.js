// Unit tests for frontend/js/rule-building-details.js: the slanted roof, attic walls, gable windows
// and balconies an urban rule adds, as plan geometry in metres (metresPerUnit 1).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const D = require('../../frontend/js/rule-building-details.js');

// A 20 m (east) × 10 m (north) house: its long sides face north and south.
const house = [[0, 0], [20, 0], [20, 10], [0, 10]];
const tan = Math.tan(D.ROOF_PITCH_DEG * Math.PI / 180);
const rule = (extra = {}) => ({ floorHeightM: 3, ...extra });

describe('the ridge', () => {
    it('runs along the longer side of a free-standing house', () => {
        const frame = D.roofFrame(house);
        expect(Math.abs(frame.axis[0])).toBeCloseTo(1, 6);
        expect(frame.halfDepth).toBeCloseTo(5, 6);
        expect(D.roofHeightAt(frame, 10, 5)).toBeCloseTo(5 * tan, 6);
        expect(D.roofHeightAt(frame, 10, 0)).toBeCloseTo(0, 6);
        expect(D.roofHeightAt(frame, 3, 7.5)).toBeCloseTo(2.5 * tan, 6);
    });

    it('follows the street, not the longer side, for a deep terrace house between neighbours', () => {
        // 8 m of street frontage, 14 m deep; its east and west walls are shared.
        const narrow = [[0, 0], [8, 0], [8, 14], [0, 14]];
        const neighbours = [[[-8, 0], [0, 0], [0, 14], [-8, 14]], [[8, 0], [16, 0], [16, 14], [8, 14]]];
        const party = D.partyEdges(D.ccw(narrow), neighbours, 1);
        expect(party).toEqual([false, true, false, true]);
        const frame = D.roofFrame(narrow, { party });
        expect(Math.abs(frame.axis[0])).toBeCloseTo(1, 6);
        expect(D.roofFrame(narrow).axis[1]).not.toBeCloseTo(0, 3); // alone, it would turn
    });

    it('scales heights by metresPerUnit when plan units are not metres', () => {
        const frame = D.roofFrame(house.map(([x, y]) => [x * 2, y * 2]), { metresPerUnit: 0.5 });
        expect(frame.riseM).toBeCloseTo(5 * tan, 6);
    });
});

describe('roof planes and attic walls', () => {
    it('splits the footprint into two slopes meeting at the ridge', () => {
        const frame = D.roofFrame(house);
        const faces = D.roofFaces(house, frame);
        expect(faces).toHaveLength(2);
        const area = faces.reduce((sum, f) => sum + Math.abs(D.signedArea(f.ring)), 0);
        expect(area).toBeCloseTo(200, 6);
        for (const face of faces) expect(face.ring.some(([, y]) => Math.abs(y - 5) < 1e-9)).toBe(true);
    });

    it('raises walls only on the gables, up to the ridge', () => {
        const walls = D.atticWalls(house, D.roofFrame(house));
        expect(walls).toHaveLength(2);
        for (const wall of walls) {
            expect(Math.abs(wall.normal[0])).toBeCloseTo(1, 6);       // east and west ends
            expect(Math.max(...wall.points.map(p => p[2]))).toBeCloseTo(5 * tan, 6);
            expect(wall.points.filter(p => p[2] === 0)).toHaveLength(2);
        }
    });

    it('puts windows in the gables and none in party walls', () => {
        const frame = D.roofFrame(house);
        const windows = D.gableWindows(house, frame, [false, false, false, false]);
        expect(windows.length).toBeGreaterThanOrEqual(2);
        for (const w of windows) {
            expect(Math.abs(w.normal[0])).toBeCloseTo(1, 6);
            const head = w.sillM + w.heightM;
            expect(D.roofHeightAt(frame, ...w.center)).toBeGreaterThan(head);
        }
        expect(D.gableWindows(house, frame, [false, true, false, true])).toEqual([]);
    });
});

describe('balconies', () => {
    it('line the long facades on every storey above the ground floor', () => {
        const frame = D.roofFrame(house);
        const out = D.balconies(house, frame, [false, false, false, false], { depthM: 2, floorHeightM: 3, eaveM: 9 });
        // 20 m facades hold four balconies each; two facades; storeys 2 and 3.
        expect(out).toHaveLength(4 * 2 * 2);
        expect(new Set(out.map(b => b.slabTopM))).toEqual(new Set([3, 6]));
        for (const b of out) {
            expect(Math.abs(b.normal[1])).toBeCloseTo(1, 6);
            expect(Math.hypot(b.b[0] - b.a[0], b.b[1] - b.a[1])).toBeCloseTo(3, 6);
        }
    });

    it('stand out of the wall by exactly the permitted depth', () => {
        const frame = D.roofFrame(house);
        const [south] = D.balconies(house, frame, [false, false, false, false], { depthM: 2, floorHeightM: 3, eaveM: 6 })
            .filter(b => b.normal[1] < 0);
        const { slab } = D.balconyPrisms(south, 1);
        const ys = [];
        for (let i = 1; i < slab.length; i += 3) ys.push(slab[i]);
        expect(Math.min(...ys)).toBeCloseTo(-2, 6);
        expect(Math.max(...ys)).toBeCloseTo(0, 6);
    });

    it('skip party walls and single-storey buildings', () => {
        const frame = D.roofFrame(house);
        expect(D.balconies(house, frame, [true, false, true, false], { depthM: 2, floorHeightM: 3, eaveM: 9 })).toEqual([]);
        expect(D.balconies(house, frame, [false, false, false, false], { depthM: 2, floorHeightM: 3, eaveM: 3 })).toEqual([]);
    });
});

describe('plan', () => {
    it('is null when the rule asks for neither', () => {
        expect(D.plan(rule(), house, { eaveM: 9 })).toBeNull();
        expect(D.plan(null, house, { eaveM: 9 })).toBeNull();
    });

    it('gives a courtyard footprint balconies but no roof', () => {
        const result = D.plan(rule({ roof: 'pitched', balconyDepthM: 1.5 }), house, { eaveM: 9, hasHoles: true });
        expect(result.roof).toBe(false);
        expect(result.windows).toEqual([]);
        expect(result.balconies.every(b => b.depthM === 1.5)).toBe(true);
    });

    it('builds closed prisms with outward faces', () => {
        const p = D.prismPositions([[0, 0], [1, 0], [1, 1], [0, 1]], 0, 1);
        expect(p).toHaveLength(12 * 9);
        // The top's first triangle faces up.
        const [ax, ay, , bx, by, , cx, cy] = p;
        expect((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)).toBeGreaterThan(0);
    });
});

describe('roof shade', () => {
    it('is stable per building and spans dark red to brown', () => {
        expect(D.roofShade('a')).toEqual(D.roofShade('a'));
        const shades = Array.from({ length: 200 }, (_, i) => D.roofShade(JSON.stringify(['p', 'parcel-' + i, i])));
        expect(new Set(shades.map(s => s.step)).size).toBeGreaterThan(8);
        for (const s of shades) {
            expect(s.hue).toBeGreaterThanOrEqual(2);
            expect(s.hue).toBeLessThanOrEqual(26);
            expect(s.lightness).toBeLessThanOrEqual(34);
        }
    });
});

describe('the mansard roof', () => {
    // A terrace house: 5 m of street frontage (along x), 9 m deep, neighbours on both sides.
    const terrace = [[0, 0], [5, 0], [5, 9], [0, 9]];
    const party = [false, true, false, true];
    const frame = D.roofFrame(terrace, { party, kind: 'mansard' });
    const lowerRun = D.MANSARD.lowerRiseM / Math.tan(70 * Math.PI / 180);

    it('starts behind the parapet, rises steeply for a storey, then shallowly', () => {
        expect(frame.kind).toBe('mansard');
        expect(D.roofHeightAt(frame, 2.5, 0.2)).toBe(0);                                  // the gutter behind the parapet
        expect(D.roofHeightAt(frame, 2.5, D.MANSARD.setbackM)).toBeCloseTo(0, 6);
        expect(D.roofHeightAt(frame, 2.5, D.MANSARD.setbackM + lowerRun)).toBeCloseTo(2.25, 6);
        const slopes = D.roofFaces(terrace, frame).filter(face => face.side === 1).map(face => Math.round(face.pitch * 180 / Math.PI));
        expect(slopes).toEqual([0, 70, 30]);                                              // gutter, lower slope, upper slope
        // The same on the garden side.
        expect(D.roofHeightAt(frame, 2.5, 9 - D.MANSARD.setbackM - lowerRun)).toBeCloseTo(2.25, 6);
        // 4.5 m in, the upper slope has risen (4.5 − 0.38 − lowerRun) · tan 30°, under its 2 m limit.
        expect(frame.riseM).toBeCloseTo(2.25 + (4.5 - D.MANSARD.setbackM - lowerRun) * Math.tan(30 * Math.PI / 180), 6);
        expect(frame.riseM).toBeLessThan(4.25);
    });

    it('lowers the upper slope on a deep building so it stays 2 m above the lower one', () => {
        const deep = [[0, 0], [30, 0], [30, 24], [0, 24]];
        const neighbours = [[[-30, 0], [0, 0], [0, 24], [-30, 24]], [[30, 0], [60, 0], [60, 24], [30, 24]]];
        const deepFrame = D.roofFrame(deep, { party: D.partyEdges(D.ccw(deep), neighbours, 1), kind: 'mansard' });
        expect(deepFrame.riseM).toBeCloseTo(4.25, 6);
        expect(D.roofHeightAt(deepFrame, 15, 12)).toBeCloseTo(4.25, 6);
        const pitches = D.roofFaces(deep, deepFrame).filter(face => face.side === 1).map(face => face.pitch * 180 / Math.PI);
        expect(pitches.slice(0, 2).map(Math.round)).toEqual([0, 70]);
        expect(pitches[2]).toBeCloseTo(Math.atan2(2, 12 - D.MANSARD.setbackM - lowerRun) * 180 / Math.PI, 6);
        expect(pitches[2]).toBeLessThan(30);
        // The faces cover the footprint exactly.
        const covered = D.roofFaces(deep, deepFrame).reduce((sum, face) => sum + Math.abs(D.signedArea(face.ring)), 0);
        expect(covered).toBeCloseTo(30 * 24, 6);
    });

    it('is hipped on a free end and gabled on a party wall', () => {
        // The end of a terrace: a neighbour to the west only.
        const end = D.roofFrame(terrace, { party: [false, false, false, true], kind: 'mansard' });
        expect(end.sides.map(side => side.key)).toEqual([1, -1, 'hip-max']);
        expect(D.roofHeightAt(end, 5, 4.5)).toBe(0);                       // the free east wall stays at the eave
        expect(D.roofHeightAt(end, 5 - D.MANSARD.setbackM - lowerRun, 4.5)).toBeCloseTo(2.25, 6);
        expect(D.roofHeightAt(end, 0, 4.5)).toBeCloseTo(end.riseM, 6);    // the party wall is a gable
        expect(D.atticWalls(terrace, end)).toHaveLength(1);
        const faces = D.roofFaces(terrace, end);
        expect(faces.filter(face => face.side === 'hip-max').map(face => Math.round(face.pitch * 180 / Math.PI))).toEqual([0, 70, 30]);
        expect(faces.reduce((sum, face) => sum + Math.abs(D.signedArea(face.ring)), 0)).toBeCloseTo(45, 6);
        // The storey loses the setback on the free end too.
        expect(D.mansardFloorAreaM2(terrace, end)).toBeCloseTo((5 - D.MANSARD.setbackM) * (9 - 2 * D.MANSARD.setbackM), 6);
        // Free-standing: every side slopes, no wall rises above the eave. A pitched roof keeps its gables.
        const alone = D.roofFrame(terrace, { kind: 'mansard' });
        expect(alone.sides).toHaveLength(4);
        expect(D.atticWalls(terrace, alone)).toEqual([]);
        expect(D.roofFrame(terrace).sides).toHaveLength(2);
        expect(D.atticWalls(terrace, D.roofFrame(terrace))).toHaveLength(2);
    });

    it('raises the party walls in the mansard outline, starting behind the setback', () => {
        const walls = D.atticWalls(terrace, frame);
        expect(walls).toHaveLength(2);                                   // the two party walls; the street and garden walls stay at the eave
        for (const wall of walls) {
            const base = wall.points.filter(p => p[2] === 0).map(p => p[1]).sort((a, b) => a - b);
            expect(base[0]).toBeCloseTo(D.MANSARD.setbackM, 6);
            expect(base[1]).toBeCloseTo(9 - D.MANSARD.setbackM, 6);
            expect(Math.max(...wall.points.map(p => p[2]))).toBeCloseTo(frame.riseM, 6);
            // The triangles fill the outline: same area as the roof's cross-section.
            const area = wall.triangles.reduce((sum, [a, b, c]) => sum + Math.abs((b[1] - a[1]) * (c[2] - a[2]) - (c[1] - a[1]) * (b[2] - a[2])) / 2, 0);
            const section = 2 * (lowerRun * 2.25 / 2 + (4.5 - D.MANSARD.setbackM - lowerRun) * (2.25 + frame.riseM) / 2);
            expect(area).toBeCloseTo(section, 6);
        }
    });

    it('puts dormers in the street and garden slopes, none in party walls, none on a pitched roof', () => {
        const dormers = D.dormers(terrace, frame, party);
        expect(dormers).toHaveLength(2);
        expect(dormers.map(d => d.normal[1]).sort()).toEqual([-1, 1]);
        for (const dormer of dormers) expect(Math.min(dormer.center[1], 9 - dormer.center[1])).toBeCloseTo(D.MANSARD.setbackM, 6);
        expect(D.dormers(terrace, D.roofFrame(terrace, { party }), party)).toEqual([]);
        expect(D.plan(rule({ roof: 'mansard' }), terrace, { eaveM: 9 }).dormers.length).toBeGreaterThan(0);
        expect(D.plan(rule({ roof: 'pitched' }), terrace, { eaveM: 9 }).dormers).toEqual([]);
        const prisms = D.dormerPrisms(dormers[0], 9, 1);
        for (const solid of [prisms.body, prisms.frame, prisms.glass]) expect(solid.length % 9).toBe(0);
    });

    it('holds a storey: the footprint behind the two setbacks', () => {
        expect(D.mansardFloorAreaM2(terrace, frame)).toBeCloseTo(5 * (9 - 2 * D.MANSARD.setbackM), 6);
    });

    it('is read from a building\'s rule, else from the building itself', () => {
        expect(D.roofKindOf({ properties: { urbanRule: { roof: 'mansard' } } })).toBe('mansard');
        expect(D.roofKindOf({ properties: { roof: 'pitched' } })).toBe('pitched');
        expect(D.roofKindOf({ properties: { roof: 'flat' } })).toBeNull();
        expect(D.detailRuleOf({ properties: { roof: 'mansard' } })).toMatchObject({ roof: 'mansard' });
        expect(D.detailRuleOf({ properties: { height: 9 } })).toBeNull();
    });
});
