// Per-provider query caps must serialize queued calls fairly and coordinate with the shared
// cooldown, so viewport and exact-ID requests cannot race a failed upstream service.
import { describe, expect, it, vi } from 'vitest';
import { withSourceConcurrency, withSourceCooldown } from '../parcels/sources.js';

const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const noop = vi.fn(async value => value);
const adapterWith = overrides => ({ queryBounds: noop, queryIds: noop, queryGeometry: noop, ...overrides });

describe('withSourceConcurrency', () => {
    it('enforces a shared FIFO limit across query methods and hands slots to waiters', async () => {
        const pending = new Map();
        const started = [];
        let active = 0, peak = 0;
        const call = vi.fn((method, name) => {
            started.push(name);
            active++;
            peak = Math.max(peak, active);
            const gate = deferred(); pending.set(name, gate);
            return gate.promise.finally(() => { active--; });
        });
        const wrapped = withSourceConcurrency(adapterWith({
            queryBounds: name => call('bounds', name),
            queryIds: name => call('ids', name),
            queryGeometry: name => call('geometry', name)
        }), { limit: 2 });

        const first = wrapped.queryBounds('first');
        const second = wrapped.queryIds('second');
        const third = wrapped.queryGeometry('third');
        const fourth = wrapped.queryBounds('fourth');
        await Promise.resolve();
        expect(started).toEqual(['first', 'second']);

        pending.get('first').resolve('one');
        await expect(first).resolves.toBe('one');
        await Promise.resolve();
        expect(started).toEqual(['first', 'second', 'third']);
        expect(peak).toBe(2);

        pending.get('second').resolve('two');
        await expect(second).resolves.toBe('two');
        await Promise.resolve();
        expect(started).toEqual(['first', 'second', 'third', 'fourth']);
        pending.get('third').resolve('three'); pending.get('fourth').resolve('four');
        await expect(Promise.all([third, fourth])).resolves.toEqual(['three', 'four']);
        expect(peak).toBe(2);
    });

    it('releases a slot after rejection so the next call can proceed', async () => {
        const firstGate = deferred();
        const raw = adapterWith({ queryBounds: vi.fn(() => firstGate.promise), queryIds: vi.fn(async () => 'next') });
        const wrapped = withSourceConcurrency(raw, { limit: 1 });
        const first = wrapped.queryBounds([]);
        const second = wrapped.queryIds([]);
        await Promise.resolve();
        expect(raw.queryIds).not.toHaveBeenCalled();
        firstGate.reject(new Error('provider failed'));
        await expect(first).rejects.toThrow('provider failed');
        await expect(second).resolves.toBe('next');
        expect(raw.queryIds).toHaveBeenCalledOnce();
    });

    it('checks cooldown only after a queued call receives a slot', async () => {
        const firstGate = deferred();
        const upstream = adapterWith({ queryBounds: vi.fn(() => firstGate.promise), queryIds: vi.fn(async () => 'unexpected') });
        const limited = Object.assign(new Error('provider unavailable'), { code: 'parcel-source-unavailable' });
        const wrapped = withSourceConcurrency(withSourceCooldown(upstream, { now: () => 0 }), { limit: 1 });
        const first = wrapped.queryBounds([]);
        const queued = wrapped.queryIds(['id']);
        await Promise.resolve();
        firstGate.reject(limited);
        await expect(first).rejects.toMatchObject({ code: 'parcel-source-unavailable' });
        await expect(queued).rejects.toMatchObject({ code: 'parcel-source-unavailable' });
        expect(upstream.queryIds).not.toHaveBeenCalled();
    });

    it.each([0, -1, 1.5, 17, '2', null])('rejects invalid limit %j', limit => {
        expect(() => withSourceConcurrency(adapterWith(), { limit })).toThrow(/integer from 1 to 16/);
    });
});
