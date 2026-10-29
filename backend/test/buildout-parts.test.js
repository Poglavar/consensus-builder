// What the model view draws of a design that is planned or under construction
// (frontend/js/buildout-parts.js): floors, pit, scaffold and crane, laid road length, covered ground.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const P = require('../../frontend/js/buildout-parts.js');
const S = require('../../frontend/js/buildout-schedule.js');

const at = (start, end, month) => S.stateAt({ start, end }, month);
const flat = { distance: (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]), lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] };
const square = { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] };
const ringArea = ring => Math.abs(ring.reduce((sum, p, i) => i ? sum + (ring[i - 1][0] + p[0]) * (p[1] - ring[i - 1][1]) : sum, 0)) / 2;

describe('building sites', () => {
    it('counts storeys from a height', () => {
        expect(P.storeys(19.8, 3.3)).toBe(6);
        expect(P.storeys(2, 3.3)).toBe(1);
        expect(P.storeys(null, 3.3)).toBe(1);
    });
    it('is absent before its start, a pit at first, a rising frame with scaffold and crane, then whole', () => {
        expect(P.buildingSite(6, at('2027-01', '2027-12', '2026-12'))).toBeNull();
        expect(P.buildingSite(6, at('2027-01', '2027-12', '2027-01'))).toEqual({ floors: 0, pit: true, scaffold: false, crane: true });
        expect(P.buildingSite(6, at('2027-01', '2027-12', '2027-06'))).toEqual({ floors: 3, pit: false, scaffold: true, crane: true });
        expect(P.buildingSite(6, at('2027-01', '2027-12', '2027-12'))).toEqual({ floors: 6, pit: false, scaffold: true, crane: true });
        expect(P.buildingSite(6, at('2027-01', '2027-12', '2028-01'))).toEqual({ floors: 6, pit: false, scaffold: false, crane: false });
        expect(P.buildingSite(6, S.BUILT).floors).toBe(6);
    });
});

describe('redraw keys', () => {
    it('change with a building floor or a tenth of a ground, not with every month', () => {
        const months = ['2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06', '2027-07', '2027-08', '2027-09', '2027-10', '2027-11', '2027-12'];
        const keys = months.map(month => P.siteKey(at('2027-01', '2027-12', month), { buildings: [{ floors: 3 }] }));
        expect(new Set(keys).size).toBe(4); // 0, 1, 2 and 3 floors
        expect(P.siteKey(at('2027-01', '2027-12', '2026-05'), { buildings: [{ floors: 3 }] })).toBe('planned');
        expect(P.siteKey(S.BUILT, { buildings: [{ floors: 3 }] })).toBe('built');
        const longRoad = Array.from({ length: 48 }, (_, i) => P.siteKey(at('2027-01', '2030-12', S.addMonths('2027-01', i)), { area: true }));
        expect(new Set(longRoad).size).toBe(11); // tenths 0 to 10
        expect(P.areaShare(0.55)).toBe(0.5);
        expect(P.areaStep(1)).toBe(10);
    });
    it('follow the own state of each building of a simulated urban rule', () => {
        const design = at('2027-01', '2028-12', '2027-06');
        const buildings = month => [{ floors: 4, state: at('2027-01', '2027-04', month) }, { floors: 4, state: at('2027-05', '2027-08', month) }, { floors: 4, state: at('2028-01', '2028-12', month) }];
        expect(P.siteKey(design, { buildings: buildings('2027-06') })).toBe('construction:b,2,p');
        expect(P.siteKey(design, { buildings: buildings('2027-07') })).toBe('construction:b,3,p');
        expect(P.siteKey(design, { buildings: [{ floors: 4 }] })).toBe('construction:1');
    });
    it('report which designs changed and whether the not-started or not-built sets did', () => {
        const before = new Map([['1', { key: 'planned', phase: 'planned' }], ['2', { key: 'construction:1', phase: 'construction' }]]);
        const same = P.diffSites(before, new Map(before));
        expect(same.changed.size).toBe(0);
        expect(same.plannedChanged || same.unbuiltChanged).toBe(false);
        const started = P.diffSites(before, new Map([['1', { key: 'construction:0', phase: 'construction' }], ['2', { key: 'construction:2', phase: 'construction' }]]));
        expect([...started.changed]).toEqual(['1', '2']);
        expect(started.plannedChanged).toBe(true);
        expect(started.unbuiltChanged).toBe(false);
        const finished = P.diffSites(before, new Map([['1', before.get('1')]]));
        expect([...finished.changed]).toEqual(['2']);
        expect(finished.plannedChanged).toBe(false);
        expect(finished.unbuiltChanged).toBe(true);
    });
});

describe('laid road length', () => {
    const runs = [[[0, 0], [10, 0]], [[10, 0], [10, 30]]];
    it('lays runs in order up to the share of their total length', () => {
        const half = P.splitRunsAtShare(runs, 0.5, flat);
        expect(half.laid).toEqual([[[0, 0], [10, 0]], [[10, 0], [10, 10]]]);
        expect(half.rest).toEqual([null, [[10, 10], [10, 30]]]);
        const none = P.splitRunsAtShare(runs, 0, flat);
        expect(none.laid).toEqual([null, null]);
        expect(none.rest).toEqual(runs);
        const all = P.splitRunsAtShare(runs, 1, flat);
        expect(all.laid).toEqual(runs);
        expect(all.rest).toEqual([null, null]);
    });
    it('cuts inside a run between its vertices', () => {
        const { laid, rest } = P.splitRunsAtShare([[[0, 0], [4, 0], [10, 0]]], 0.7, flat);
        expect(laid[0]).toEqual([[0, 0], [4, 0], [7, 0]]);
        expect(rest[0]).toEqual([[7, 0], [10, 0]]);
    });
});

describe('covered ground', () => {
    it('covers the share of the area from the west and leaves the rest bare, nothing at 0 and all at 1', () => {
        const { covered, bare } = P.groundShares(square, 0.3);
        expect(covered.type).toBe('Polygon');
        expect(ringArea(covered.coordinates[0])).toBeCloseTo(30, 3);
        expect(Math.max(...covered.coordinates[0].map(p => p[0]))).toBeCloseTo(3, 3);
        expect(ringArea(bare.coordinates[0])).toBeCloseTo(70, 3);
        expect(Math.min(...bare.coordinates[0].map(p => p[0]))).toBeCloseTo(3, 3);
        expect(P.groundShares(square, 0)).toEqual({ covered: null, bare: square });
        expect(P.groundShares(square, 1)).toEqual({ covered: square, bare: null });
    });
    it('measures by area across a concave or holed ground', () => {
        const holed = { type: 'Polygon', coordinates: [square.coordinates[0], [[2, 2], [2, 8], [8, 8], [8, 2], [2, 2]]] };
        const part = P.groundShares(holed, 0.5).covered;
        const area = ringArea(part.coordinates[0]) - part.coordinates.slice(1).reduce((sum, ring) => sum + ringArea(ring), 0);
        expect(area).toBeCloseTo(32, 2);
        const ell = { type: 'MultiPolygon', coordinates: [[[[0, 0], [2, 0], [2, 10], [0, 10], [0, 0]]], [[[5, 0], [10, 0], [10, 2], [5, 2], [5, 0]]]] };
        const covered = P.groundShares(ell, 0.5).covered;
        expect(covered.type).toBe('Polygon'); // the western strip alone holds half
        expect(ringArea(covered.coordinates[0])).toBeCloseTo(15, 2);
    });
});
