// Unit tests for utils/single-flight-memo.js: one shared in-flight load per key, the settled value
// served until its TTL runs out (on an injected clock), failures never kept, and the key bound.
import { describe, expect, it } from 'vitest';
import { createSingleFlightMemo } from '../utils/single-flight-memo.js';

// A load that resolves only when told to, counting how often it ran.
function deferredLoad() {
    const pending = [];
    const load = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
    return { load, pending };
}

describe('createSingleFlightMemo', () => {
    it('shares one in-flight load among concurrent callers of a key', async () => {
        const memo = createSingleFlightMemo({ ttlMs: 1000 });
        const { load, pending } = deferredLoad();
        const first = memo.get('k', load);
        const second = memo.get('k', load);
        await Promise.resolve();
        expect(pending).toHaveLength(1);
        pending[0].resolve({ events: [] });
        expect(await first).toBe(await second);
    });

    it('serves the settled value until the TTL runs out, then loads again', async () => {
        let clock = 0;
        const memo = createSingleFlightMemo({ ttlMs: 20000, now: () => clock });
        let loads = 0;
        const load = async () => ++loads;
        expect(await memo.get('k', load)).toBe(1);
        clock = 19999;
        expect(await memo.get('k', load)).toBe(1);
        clock = 20000;
        expect(await memo.get('k', load)).toBe(2);
        expect(loads).toBe(2);
    });

    it('keeps the TTL from when the load settled, not from when it started', async () => {
        let clock = 0;
        const memo = createSingleFlightMemo({ ttlMs: 100, now: () => clock });
        const { load, pending } = deferredLoad();
        const answer = memo.get('k', load);
        await Promise.resolve();
        clock = 500;
        pending[0].resolve('slow');
        await answer;
        clock = 599;
        expect(await memo.get('k', async () => 'fresh')).toBe('slow');
    });

    it('does not keep a rejection: the next caller loads again', async () => {
        const memo = createSingleFlightMemo({ ttlMs: 1000 });
        await expect(memo.get('k', async () => { throw new Error('down'); })).rejects.toThrow('down');
        expect(memo.size()).toBe(0);
        expect(await memo.get('k', async () => 'up')).toBe('up');
    });

    it('keys separately and holds at most maxKeys, dropping the oldest', async () => {
        const memo = createSingleFlightMemo({ ttlMs: 1000, maxKeys: 2 });
        let loads = 0;
        const load = async () => ++loads;
        await memo.get('a', load);
        await memo.get('b', load);
        await memo.get('c', load);
        expect(memo.size()).toBe(2);
        expect(await memo.get('b', load)).toBe(2);
        expect(await memo.get('c', load)).toBe(3);
        expect(await memo.get('a', load)).toBe(4);
        expect(memo.size()).toBe(2);
    });

    it('refuses a missing TTL or a bound that is not a positive integer', () => {
        expect(() => createSingleFlightMemo({})).toThrow('ttlMs');
        expect(() => createSingleFlightMemo({ ttlMs: 10, maxKeys: 0 })).toThrow('maxKeys');
    });
});
