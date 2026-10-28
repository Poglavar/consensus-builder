// Photo-view preload visits the flight at even moments and waits at each for the tiles to settle.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const Preload = require('../../frontend/js/camera-flight-preload.js');

// A fake clock advanced one 16 ms frame per nextFrame, and a progress script per frame.
function frames(script) {
    let t = 0, frame = 0;
    return { now: () => t, nextFrame: async () => { t += 16; frame++; }, progress: () => script(frame), get frame() { return frame; } };
}

describe('camera flight tile preload', () => {
    it('spaces moments evenly including both ends and caps their number', () => {
        expect(Preload.sampleTimes(10, { stepSeconds: 2 })).toEqual([0, 2, 4, 6, 8, 10]);
        expect(Preload.sampleTimes(0)).toEqual([0, 0]);
        expect(Preload.sampleTimes(600, { stepSeconds: 2, max: 60 })).toHaveLength(60);
        expect(() => Preload.sampleTimes(NaN)).toThrow();
    });
    it('waits through a dip until progress stays complete', async () => {
        // Complete at once, dips at frames 3–4 as children queue, then stays complete.
        const clock = frames(f => (f === 3 || f === 4 ? .6 : 1));
        expect(await Preload.settle({ ...clock, stableFrames: 6 })).toBe('loaded');
        expect(clock.frame).toBe(10);
    });
    it('gives up after the timeout instead of hanging on a stalled stream', async () => {
        const clock = frames(() => .5);
        expect(await Preload.settle({ ...clock, timeoutMs: 1000 })).toBe('timeout');
        expect(clock.frame).toBeLessThanOrEqual(64);
    });
    it('visits every moment, returns to the start and reports progress and timeouts', async () => {
        const seeks = [], reports = [], clock = frames(() => 1);
        const result = await Preload.preload({ times: [0, 5, 10], seek: async t => { seeks.push(t); }, ...clock,
            onProgress: (done, total) => reports.push(`${done}/${total}`), stableFrames: 2 });
        expect(seeks).toEqual([0, 5, 10, 0]); expect(reports).toEqual(['1/3', '2/3', '3/3']);
        expect(result).toEqual({ aborted: false, outcomes: ['loaded', 'loaded', 'loaded'], timeouts: 0, skipped: 0 });
    });
    it('starts the flight once the budget is spent, skipping the remaining moments', async () => {
        const seeks = [], clock = frames(() => .5);
        const result = await Preload.preload({ times: [0, 5, 10, 15], seek: async t => { seeks.push(t); }, ...clock, timeoutMs: 1000, budgetMs: 1500 });
        expect(result.outcomes).toEqual(['timeout', 'timeout', 'skipped', 'skipped']); expect(result.skipped).toBe(2);
        expect(seeks).toEqual([0, 5, 0]);
    });
    it('stops when aborted', async () => {
        const controller = new AbortController(), seeks = [], clock = frames(() => 1);
        const result = await Preload.preload({ times: [0, 5, 10], seek: async t => { seeks.push(t); if (t === 5) controller.abort(); }, ...clock, signal: controller.signal, stableFrames: 2 });
        expect(result.aborted).toBe(true); expect(seeks).toEqual([0, 5]);
    });
});
