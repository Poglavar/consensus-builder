// What the Permitted layer keeps drawn as the view moves (frontend/js/planning/scene.js retainDrawn):
// a cell stays until its replacement lands, and goes only out of range or when its scope is not shown.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const scene = require('../../frontend/js/planning/scene.js');

const S = 'envelopes:alatau:alatau-genplan-727';
const cell = (key, w, s) => ({ key: `${S}|${key}`, scope: S, cell: { bbox: [w, s, w + 0.0025, s + 0.0025] } });

describe('the range around a view', () => {
    it('is the view grown by its own size on every side', () => {
        expect(scene.rangeAround([10, 20, 11, 22])).toEqual([9, 18, 12, 24]);
    });

    it('in 3D reaches at least twice the camera distance around its target, whatever the box', () => {
        // A camera tilted near the horizon: its box is a few metres, its distance 1,100 m.
        const box = [77.0929, 43.7980, 77.0931, 43.7982];
        const [w, s, e, n] = scene.rangeAround(box, { centre: [43.7981, 77.0930], reachM: 1100 });
        expect((n - s) * 110570).toBeCloseTo(4 * 1100, -1);
        expect((e - w) * 111320 * Math.cos(43.7981 * Math.PI / 180)).toBeCloseTo(4 * 1100, -1);
        // A box larger than that reach keeps its own grown size.
        expect(scene.rangeAround([77, 43, 78, 44], { centre: [43.5, 77.5], reachM: 10 })).toEqual([76, 42, 79, 45]);
    });
});

describe('cells kept drawn as the view moves', () => {
    const near = cell('near', 77.09, 43.79), far = cell('far', 77.095, 43.795), gone = cell('gone', 77.2, 43.9);

    it('keeps a cell that left the view but is in range, and drops one out of range', () => {
        const drawn = new Map();
        scene.retainDrawn(drawn, { jobs: [near, far, gone], answers: new Map([[near.key, 'n'], [far.key, 'f'], [gone.key, 'g']]), range: [77, 43.7, 77.3, 44] });
        // A tilt: the view's box shrinks to the near cell only; the far one is still within the range.
        const shown = scene.retainDrawn(drawn, { jobs: [near], answers: new Map([[near.key, 'n']]), range: [77.08, 43.78, 77.1, 43.8] });
        expect(shown).toEqual(['n', 'f']);
        expect([...drawn.keys()]).toEqual([near.key, far.key]);
    });

    it('keeps the old answer of a cell in view until its new one lands, then replaces it', () => {
        const drawn = new Map();
        const range = [77, 43.7, 77.3, 44];
        scene.retainDrawn(drawn, { jobs: [near], answers: new Map([[near.key, 'old']]), range });
        // The cell's cache expired: it is pending again, nothing landed yet.
        expect(scene.retainDrawn(drawn, { jobs: [near], answers: new Map(), range })).toEqual(['old']);
        expect(scene.retainDrawn(drawn, { jobs: [near], answers: new Map([[near.key, 'new']]), range })).toEqual(['new']);
    });

    it('drops cells whose scope is no longer shown', () => {
        const drawn = new Map();
        const range = [77, 43.7, 77.3, 44];
        scene.retainDrawn(drawn, { jobs: [near], answers: new Map([[near.key, 'n']]), range });
        const other = { key: 'areas:alatau:x:y|near', scope: 'areas:alatau:x:y', cell: near.cell };
        expect(scene.retainDrawn(drawn, { jobs: [other], answers: new Map(), range })).toEqual([]);
        expect(drawn.size).toBe(0);
    });
});
