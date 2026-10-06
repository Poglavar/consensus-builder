import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const health = require('../../frontend/js/parcels/source-health.js');
const response = (status, body = {}, retryAfter = null) => {
    const value = {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: name => name.toLowerCase() === 'retry-after' ? retryAfter : null },
        json: async () => body
    };
    value.clone = () => ({ json: value.json });
    return value;
};

describe('parcel source health requester', () => {
    it('returns successful and 404 responses for the caller to interpret', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(response(404, { code: 'invalid-parcel-source' }))
            .mockResolvedValueOnce(response(200, { features: [] }));
        const request = health.createRequester({ fetchImpl, now: () => 1, sleep: vi.fn() });
        await expect(request('https://api.example/parcel-sources/missing?ids=1')).resolves.toMatchObject({ status: 404 });
        await expect(request('https://api.example/parcel-sources/valid?ids=1')).resolves.toMatchObject({ status: 200 });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('does not retry 429, sanitizes its error and shares cooldown across query strings', async () => {
        let now = 1000;
        const fetchImpl = vi.fn().mockResolvedValue(response(502, {
            code: 'parcel-source-rate-limited', upstreamStatus: 429, retryAfterSeconds: 7,
            message: 'Retry from https://user:secret@example.invalid/?token=abc access_token=abc Authorization: Bearer tokenvalue'
        }));
        const sleep = vi.fn();
        const request = health.createRequester({ fetchImpl, now: () => now, sleep });
        await expect(request('https://api.example/parcel-sources/chicago?bbox=a', {}, 3, 50)).rejects.toMatchObject({
            status: 502, code: 'parcel-source-rate-limited', upstreamStatus: 429, retryAfterSeconds: 7
        });
        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(sleep).not.toHaveBeenCalled();
        const error = await request('https://api.example/parcel-sources/chicago?ids=1').catch(value => value);
        expect(error).toMatchObject({ code: 'parcel-source-rate-limited', upstreamStatus: 429, retryAfterSeconds: 7 });
        expect(error.message).not.toContain('example.invalid');
        expect(error.message).not.toContain('secret');
        expect(error.message).not.toContain('tokenvalue');
        expect(fetchImpl).toHaveBeenCalledOnce();
        now += 7000;
    });

    it('applies a 60-second access-block cooldown for 403', async () => {
        let now = 500;
        const fetchImpl = vi.fn().mockResolvedValue(response(403, { message: 'Denied' }));
        const request = health.createRequester({ fetchImpl, now: () => now, sleep: vi.fn() });
        await expect(request('https://api.example/parcel-sources/lima?bbox=x')).rejects.toMatchObject({
            code: 'parcel-source-blocked', upstreamStatus: 403
        });
        const cooldown = await request('https://api.example/parcel-sources/lima?ids=x').catch(value => value);
        expect(cooldown).toMatchObject({ code: 'parcel-source-blocked', upstreamStatus: 403 });
        expect(fetchImpl).toHaveBeenCalledOnce();
        now += 60000;
        fetchImpl.mockResolvedValueOnce(response(200));
        await expect(request('https://api.example/parcel-sources/lima?ids=x')).resolves.toMatchObject({ status: 200 });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('keeps a concurrent 429 cooldown when an older in-flight request succeeds', async () => {
        let resolveFirst;
        const firstResponse = new Promise(resolve => { resolveFirst = resolve; });
        const fetchImpl = vi.fn()
            .mockReturnValueOnce(firstResponse)
            .mockResolvedValueOnce(response(429, { message: 'Slow down' }))
            .mockResolvedValueOnce(response(200));
        const request = health.createRequester({ fetchImpl, now: () => 1000, sleep: vi.fn() });

        const olderRequest = request('https://api.example/parcel-sources/race?bbox=1');
        await expect(request('https://api.example/parcel-sources/race?ids=2')).rejects.toMatchObject({
            code: 'parcel-source-rate-limited', upstreamStatus: 429
        });
        resolveFirst(response(200));
        await expect(olderRequest).resolves.toMatchObject({ status: 200 });

        const duringCooldown = await request('https://api.example/parcel-sources/race?ids=3').catch(error => error);
        expect(duringCooldown).toMatchObject({ code: 'parcel-source-rate-limited', upstreamStatus: 429 });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('bounds remembered cooldowns and prunes expired entries', async () => {
        let now = 0;
        const fetchImpl = vi.fn().mockResolvedValue(response(403, { message: 'Denied' }));
        const request = health.createRequester({ fetchImpl, now: () => now, sleep: vi.fn() });
        for (let index = 0; index < 129; index += 1) {
            await expect(request(`https://api.example/parcel-sources/source-${index}`)).rejects.toMatchObject({
                code: 'parcel-source-blocked'
            });
        }
        expect(fetchImpl).toHaveBeenCalledTimes(129);

        // The oldest cooldown was evicted to keep the map bounded.
        await expect(request('https://api.example/parcel-sources/source-0')).rejects.toMatchObject({
            code: 'parcel-source-blocked'
        });
        expect(fetchImpl).toHaveBeenCalledTimes(130);

        now = 60000;
        await expect(request('https://api.example/parcel-sources/source-1')).rejects.toMatchObject({
            code: 'parcel-source-blocked'
        });
        expect(fetchImpl).toHaveBeenCalledTimes(131);
    });

    it('retries 5xx with fresh timeout signals, then cools down and recovers on success', async () => {
        let now = 0;
        const signals = [];
        const fetchImpl = vi.fn(async (_url, options) => {
            signals.push(options.signal);
            return response(503, { code: 'parcel-source-unavailable', upstreamStatus: 503, message: 'Down' });
        });
        const sleep = vi.fn(async milliseconds => { now += milliseconds; });
        const request = health.createRequester({ fetchImpl, now: () => now, sleep });
        await expect(request('https://api.example/parcel-sources/luanda?bbox=1', {}, 3, 600)).rejects.toMatchObject({
            status: 503, code: 'parcel-source-unavailable', upstreamStatus: 503
        });
        expect(fetchImpl).toHaveBeenCalledTimes(3);
        expect(sleep).toHaveBeenCalledTimes(2);
        expect(signals[0]).not.toBe(signals[1]);
        expect(signals[1]).not.toBe(signals[2]);
        const duringCooldown = await request('https://api.example/parcel-sources/luanda?ids=7').catch(value => value);
        expect(duringCooldown).toMatchObject({ code: 'parcel-source-unavailable', upstreamStatus: 503, retryAfterSeconds: 30 });
        expect(fetchImpl).toHaveBeenCalledTimes(3);
        now += 30000;
        fetchImpl.mockResolvedValueOnce(response(200, { features: [] }));
        await request('https://api.example/parcel-sources/luanda?ids=7');
        expect(fetchImpl).toHaveBeenCalledTimes(4);
        await expect(request('https://api.example/parcel-sources/luanda?ids=8')).rejects.toMatchObject({ status: 503 });
    });

    it('honors Retry-After on an unavailable gateway response instead of retrying immediately', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(response(502, {
            code: 'parcel-source-unavailable', retryAfterSeconds: 11, message: 'Source cooldown'
        }));
        const request = health.createRequester({ fetchImpl, now: () => 0, sleep: vi.fn() });
        await expect(request('https://api.example/parcel-sources/restricted?bbox=a')).rejects.toMatchObject({
            code: 'parcel-source-unavailable', retryAfterSeconds: 11
        });
        const subsequent = await request('https://api.example/parcel-sources/restricted?ids=a').catch(error => error);
        expect(subsequent).toMatchObject({ code: 'parcel-source-unavailable', retryAfterSeconds: 11 });
        expect(fetchImpl).toHaveBeenCalledOnce();
    });

    it('retries offline errors and preserves timeout status without leaking caught exception text', async () => {
        const fetchImpl = vi.fn()
            .mockRejectedValueOnce(new TypeError('network failed at https://user:secret@example.invalid/?token=abc'))
            .mockRejectedValueOnce(new TypeError('network failed'))
            .mockRejectedValueOnce(new TypeError('network failed'));
        const sleep = vi.fn(async () => {});
        const request = health.createRequester({ fetchImpl, now: () => 0, sleep });
        const error = await request('https://api.example/parcel-sources/offline?bbox=a').catch(value => value);
        expect(error).toMatchObject({ status: 502, code: 'parcel-source-unavailable' });
        expect(error.message).not.toContain('example.invalid');
        expect(error.message).not.toContain('secret');
        expect(fetchImpl).toHaveBeenCalledTimes(3);
        expect(sleep).toHaveBeenCalledTimes(2);

        const timeoutRequest = health.createRequester({
            fetchImpl: async () => { const timeout = new Error('timeout at https://secret.invalid'); timeout.name = 'TimeoutError'; throw timeout; },
            now: () => 0, sleep: vi.fn()
        });
        await expect(timeoutRequest('https://api.example/parcel-sources/timeout')).rejects.toMatchObject({
            status: 504, code: 'parcel-source-unavailable', message: 'Parcel source request timed out.'
        });
    });

    it('describes offline, rate-limited, blocked, timeout and unavailable states', () => {
        expect(health.describeFailure(new Error('x'), { offline: true })).toContain('You appear to be offline');
        expect(health.describeFailure({ code: 'parcel-source-rate-limited', retryAfterSeconds: 8 })).toContain('Retry in 8 seconds');
        expect(health.describeFailure({ code: 'parcel-source-blocked', upstreamStatus: 403 })).toContain('restrict IP addresses or require authentication');
        expect(health.describeFailure({ status: 504 })).toContain('timed out');
        expect(health.describeFailure({ code: 'parcel-source-unavailable' })).toContain('temporarily unavailable');
        for (const failure of [
            { code: 'parcel-source-rate-limited', retryAfterSeconds: 8 },
            { code: 'parcel-source-blocked', upstreamStatus: 403 },
            { status: 504 },
            { code: 'parcel-source-unavailable' }
        ]) expect(health.describeFailure(failure)).toContain('Already loaded parcels remain visible. Retry or choose another source.');
        const translate = vi.fn((key, values) => `${key}:${JSON.stringify(values)}`);
        expect(health.describeFailure({ code: 'parcel-source-blocked' }, { translate })).toContain('parcelSourceHealth.blocked:{"status":403}');
        expect(translate).toHaveBeenCalledWith('parcelSourceHealth.blocked', { status: 403 });
    });

    it('says how many parcels are still loaded, in memory and in view, when the counts are known', () => {
        const failure = { code: 'parcel-source-unavailable' };
        expect(health.describeFailure(failure, { loaded: { inMemory: 181, inView: 42 } }))
            .toBe('This parcel source is temporarily unavailable. 181 parcels are loaded in memory, 42 of them in this view; they stay on the map. Retry or choose another source.');
        expect(health.describeFailure(failure, { loaded: { inMemory: 0, inView: 0 } }))
            .toBe('This parcel source is temporarily unavailable. No parcels are loaded yet. Retry or choose another source.');
        // A missing count is not a zero: it falls back to the sentence that claims no number.
        expect(health.describeFailure(failure, { loaded: { inMemory: null, inView: 3 } }))
            .toContain('Already loaded parcels remain visible.');
        const translate = vi.fn((key, values) => `${key}:${JSON.stringify(values)}`);
        expect(health.describeFailure(failure, { translate, loaded: { inMemory: 5, inView: 2 } }))
            .toContain('parcelSourceHealth.loadedCounts:{"inMemory":5,"inView":2}');
    });
});
