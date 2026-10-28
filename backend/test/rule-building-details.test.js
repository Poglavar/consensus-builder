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
