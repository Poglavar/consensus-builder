// One notice at a time (frontend/js/ui/notice-queue.js): replacement after a minimum display time,
// waiting before that, repeats dropped, expiry handing over to the next.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createNoticeQueue } = require('../../frontend/js/ui/notice-queue.js');

function harness(options = {}) {
    const shown = [];
    const hidden = [];
    const queue = createNoticeQueue({
        minDisplayMs: 1000,
        show: entry => { shown.push(entry.message); return { el: entry.message }; },
        hide: (handle, entry) => { hidden.push(entry.message); },
        ...options
    });
    return { queue, shown, hidden };
}

describe('notice queue', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('shows the first notice at once and takes it down when its duration ends', () => {
        const { queue, shown, hidden } = harness();
        expect(queue.push({ message: 'Applied 22 proposals.', duration: 3000 })).toBe(true);
        expect(shown).toEqual(['Applied 22 proposals.']);
        vi.advanceTimersByTime(2999);
        expect(hidden).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(hidden).toEqual(['Applied 22 proposals.']);
        expect(queue.current()).toBeNull();
    });

    it('lets a second notice wait until the first has been readable, then replaces it', () => {
        const { queue, shown, hidden } = harness();
        queue.push({ message: 'First', duration: 5000 });
        vi.advanceTimersByTime(300);
        queue.push({ message: 'Second', duration: 5000 });
        expect(shown).toEqual(['First']);
        expect(queue.pending().map(e => e.message)).toEqual(['Second']);
        vi.advanceTimersByTime(700);
        expect(hidden).toEqual(['First']);
        expect(shown).toEqual(['First', 'Second']);
        expect(queue.current().message).toBe('Second');
    });

    it('replaces at once a notice that has already been up long enough', () => {
        const { queue, shown, hidden } = harness();
        queue.push({ message: 'First', duration: 5000 });
        vi.advanceTimersByTime(1500);
        queue.push({ message: 'Second', duration: 5000 });
        expect(hidden).toEqual(['First']);
        expect(shown).toEqual(['First', 'Second']);
    });

    it('drops a repeat of the notice showing or waiting, and an empty one', () => {
        const { queue, shown } = harness();
        expect(queue.push({ message: 'Copied', duration: 1000 })).toBe(true);
        expect(queue.push({ message: 'Copied', duration: 1000 })).toBe(false);
        expect(queue.push({ message: 'Copied', duration: 1000, type: 'error' })).toBe(true);
        expect(queue.push({ message: 'Copied', duration: 1000, type: 'error' })).toBe(false);
        expect(queue.push({ message: '   ' })).toBe(false);
        expect(shown).toEqual(['Copied']);
        expect(queue.pending()).toHaveLength(1);
    });

    it('hands over to the next waiting notice when the current one expires early', () => {
        const { queue, shown, hidden } = harness();
        queue.push({ message: 'Short', duration: 400 });
        queue.push({ message: 'Next', duration: 5000 });
        vi.advanceTimersByTime(400);
        expect(hidden).toEqual(['Short']);
        expect(shown).toEqual(['Short', 'Next']);
    });

    it('clear takes down the current notice and forgets the waiting ones', () => {
        const { queue, hidden } = harness();
        queue.push({ message: 'A', duration: 5000 });
        queue.push({ message: 'B', duration: 5000 });
        queue.clear();
        expect(hidden).toEqual(['A']);
        expect(queue.current()).toBeNull();
        expect(queue.pending()).toEqual([]);
        vi.advanceTimersByTime(10000);
        expect(hidden).toEqual(['A']);
    });

    it('keeps a held notice up past its duration, and takes it down the minimum time after release', () => {
        const { queue, hidden } = harness();
        queue.push({ message: 'Save failed: 500', duration: 3000, type: 'error' });
        queue.hold();
        vi.advanceTimersByTime(10000);
        expect(hidden).toEqual([]);
        queue.release();
        vi.advanceTimersByTime(999);
        expect(hidden).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(hidden).toEqual(['Save failed: 500']);
    });

    it('still lets a new notice replace a held one', () => {
        const { queue, shown, hidden } = harness();
        queue.push({ message: 'Save failed: 500', duration: 3000, type: 'error' });
        queue.hold();
        vi.advanceTimersByTime(1500);
        queue.push({ message: 'Copied', duration: 1400 });
        expect(hidden).toEqual(['Save failed: 500']);
        expect(shown).toEqual(['Save failed: 500', 'Copied']);
        queue.release();
        vi.advanceTimersByTime(1400);
        expect(hidden).toEqual(['Save failed: 500', 'Copied']);
    });

    it('uses the default duration for a notice without one', () => {
        const { queue, hidden } = harness();
        queue.push({ message: 'Default' });
        vi.advanceTimersByTime(4999);
        expect(hidden).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(hidden).toEqual(['Default']);
    });
});
