// The replay's scheduler (frontend/js/work-slicer.js): the clock is read after every unit of work,
// a slice ends at the first unit past the budget, pauses yield at background priority, a
// cancellation stops the work at the next pause, and the one-shot driver gives the same answer.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const workSlicer = require('../../frontend/js/work-slicer.js');

// A clock the test advances; every read is counted.
function fakeClock() {
    const clock = { t: 0, reads: 0 };
    clock.now = () => { clock.reads += 1; return clock.t; };
    return clock;
}

// Units of work that each take `costs[i]` ms of the fake clock and record when they ran.
function* units(clock, costs, ran) {
    let total = 0;
    for (const cost of costs) {
        clock.t += cost;
        total += cost;
        ran.push(clock.t);
        yield;
    }
    return total;
}

describe('createSlicer + runSliced', () => {
    it('ends a slice at the first unit past the budget, checking the clock after every unit', async () => {
        const clock = fakeClock();
        const pausedAt = [];
        const slicer = workSlicer.createSlicer({
            budgetMs: 8,
            now: clock.now,
            yieldNow: async () => { pausedAt.push(clock.t); }
        });
        const ran = [];
        const costs = [3, 3, 3, 1, 1, 1, 1, 1, 1, 10, 2];
        const readsBefore = clock.reads;
        const total = await workSlicer.runSliced(units(clock, costs, ran), slicer);

        expect(total).toBe(27);
        // Slices: 3+3+3 (9 ≥ 8) | 1×6 = 6, +10 → 16 | 2 (left over, below the budget, no pause).
        expect(pausedAt).toEqual([9, 25]);
        expect(slicer.pauses).toBe(2);
        // One clock read per unit at least: a budget consulted every Nth step bounds nothing.
        expect(clock.reads - readsBefore).toBeGreaterThanOrEqual(costs.length);
    });

    it('pauses after a single unit that is longer than the whole budget', async () => {
        const clock = fakeClock();
        const yieldNow = vi.fn(async () => {});
        const slicer = workSlicer.createSlicer({ budgetMs: 8, now: clock.now, yieldNow });
        await workSlicer.runSliced(units(clock, [20, 20, 20], []), slicer);
        expect(yieldNow).toHaveBeenCalledTimes(3);
    });

    it('gives the same result as running the steps to completion in one go', async () => {
        const make = () => (function* steps() {
            const out = [];
            for (let i = 0; i < 50; i += 1) { out.push(i * i); yield; }
            return out;
        })();
        const clock = fakeClock();
        const slicer = workSlicer.createSlicer({ budgetMs: 1, now: () => { clock.t += 0.4; return clock.t; }, yieldNow: async () => {} });
        const sliced = await workSlicer.runSliced(make(), slicer);
        expect(sliced).toEqual(workSlicer.runToCompletion(make()));
        expect(slicer.pauses).toBeGreaterThan(5);
    });

    it('reports every pause, so a progress deadline can be moved by it', async () => {
        const clock = fakeClock();
        const onPause = vi.fn();
        const slicer = workSlicer.createSlicer({ budgetMs: 5, now: clock.now, yieldNow: async () => {}, onPause });
        await workSlicer.runSliced(units(clock, [5, 5, 5], []), slicer);
        expect(onPause).toHaveBeenCalledTimes(3);
        expect(onPause.mock.calls[0][0]).toMatchObject({ pauses: 1, sliceMs: 5 });
    });
});

describe('cancellation', () => {
    it('stops at the next pause, runs the step function\'s finally, and rejects as cancelled', async () => {
        const clock = fakeClock();
        let slicer = null;
        slicer = workSlicer.createSlicer({
            budgetMs: 4,
            now: clock.now,
            // The superseding event arrives while the slice is yielded.
            yieldNow: async () => { if (slicer.pauses === 2) slicer.cancel('city changed'); }
        });
        const ran = [];
        let cleanedUp = false;
        const steps = (function* () {
            try { yield* units(clock, [4, 4, 4, 4, 4], ran); } finally { cleanedUp = true; }
        })();
        await expect(workSlicer.runSliced(steps, slicer)).rejects.toMatchObject({
            code: 'work-cancelled', name: 'AbortError', reason: 'city changed'
        });
        expect(ran).toEqual([4, 8]);
        expect(cleanedUp).toBe(true);
        expect(workSlicer.isCancelled(workSlicer.cancelledError('x'))).toBe(true);
    });

    it('honours an AbortSignal before the first unit and at checkpoints', async () => {
        const controller = new AbortController();
        const slicer = workSlicer.createSlicer({ signal: controller.signal, yieldNow: async () => {} });
        controller.abort('leaving');
        const steps = vi.fn(function* () { yield; });
        await expect(workSlicer.runSliced(steps(), slicer)).rejects.toMatchObject({ code: 'work-cancelled', reason: 'leaving' });
        await expect(slicer.checkpoint()).rejects.toMatchObject({ code: 'work-cancelled' });
        expect(slicer.cancelled).toBe(true);
    });

    it('checkpoint() returns without yielding while the slice still has budget', async () => {
        const clock = fakeClock();
        const yieldNow = vi.fn(async () => {});
        const slicer = workSlicer.createSlicer({ budgetMs: 8, now: clock.now, yieldNow });
        clock.t = 3;
        await slicer.checkpoint();
        expect(yieldNow).not.toHaveBeenCalled();
        clock.t = 9;
        await slicer.checkpoint();
        expect(yieldNow).toHaveBeenCalledTimes(1);
    });
});

describe('backgroundYield', () => {
    it('asks scheduler.postTask for background priority, never scheduler.yield', async () => {
        const postTask = vi.fn(callback => Promise.resolve().then(callback));
        const schedulerYield = vi.fn(async () => {});
        const yieldNow = workSlicer.backgroundYield({ scheduler: { postTask, yield: schedulerYield } });
        await yieldNow();
        expect(postTask).toHaveBeenCalledWith(expect.any(Function), { priority: 'background' });
        expect(schedulerYield).not.toHaveBeenCalled();
    });

    it('falls back to a MessageChannel task where postTask is missing', async () => {
        const yieldNow = workSlicer.backgroundYield({ MessageChannel });
        const order = [];
        const done = yieldNow().then(() => order.push('yielded'));
        Promise.resolve().then(() => order.push('microtask'));
        await done;
        // A real task: every microtask queued before it ran first.
        expect(order).toEqual(['microtask', 'yielded']);
    });
});
