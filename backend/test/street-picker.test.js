// The street picker's words (frontend/js/streets/street-picker.js): segment ends, the "between"
// label, a recorded street reference read back with its compass side, and the nearest segment.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const P = require('../../frontend/js/streets/street-picker.js');

const t = (key, fallback, params = {}) => String(fallback).replace(/\{\{(\w+)\}\}/g, (_, name) => params[name] ?? '');

describe('street picker words', () => {
    it('names segment ends by the road there, or by what kind of point it is', () => {
        expect(P.endLabel({ kind: 'branch', names: ['Cross Road', 'Mill Lane'] }, t)).toBe('Cross Road / Mill Lane');
        expect(P.endLabel({ kind: 'branch', own: true }, t)).toBe('the fork');
        expect(P.endLabel({ kind: 'overpass', railway: true }, t)).toBe('the railway bridge');
        expect(P.endLabel({ kind: 'number', houseNumber: '40' }, t)).toBe('No. 40');
        expect(P.segmentLabel({ from: { kind: 'end' }, to: { kind: 'branch', names: ['Cross Road'] } }, t)).toBe('Between its end and Cross Road');
    });

    it('reads a recorded reference back with its side by compass', () => {
        const ref = { name: 'Hughes Road', part: 'segment', side: 'left', osmWayIds: ['1'],
            from: { kind: 'branch', names: ['Cross Road'], point: [-0.1, 51.5] }, to: { kind: 'end', point: [-0.09, 51.5] } };
        expect(P.referenceLabel(ref, t)).toBe('Hughes Road · Between Cross Road and its end · North side');
        expect(P.referenceLabel({ ...ref, side: 'right' }, t)).toMatch(/South side$/);
        expect(P.referenceLabel({ name: 'Hughes Road', part: 'street', side: 'both', osmWayIds: ['1'] }, t)).toBe('Hughes Road · Both sides');
    });

    it('opens on the segment nearest the click', () => {
        const segments = [{ coordinates: [[0, 0], [0.001, 0]] }, { coordinates: [[0.001, 0], [0.002, 0]] }];
        expect(P.nearestSegment(segments, [0.0018, 0.0001])).toBe(1);
        expect(P.nearestSegment(segments, [0.0001, 0])).toBe(0);
    });
});
