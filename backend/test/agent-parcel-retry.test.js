// Parcel read retries are bounded and preserve provider diagnostics without accepting incomplete data.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSourceParcels } from '../agents/source-fetch.js';

const collection = { type: 'FeatureCollection', features: [], complete: true };
const reply = (status, body = collection, headers) => new Response(JSON.stringify(body), { status, headers });
const args = ['https://api.example.test', 'es-dgc-inspire-cp-wfs', [-3.7, 40.41, -3.69, 40.42]];
const immediate = { retryDelaysMs: [0, 0] };
afterEach(() => vi.useRealTimers());

describe('proposer parcel read retries', () => {
    it('recovers on the third attempt after 502 and 504, retrying the identical read', async () => {
        const fetchImpl = vi.fn().mockResolvedValueOnce(reply(502)).mockResolvedValueOnce(reply(504)).mockResolvedValueOnce(reply(200));
        const logged = [];
        const sleep = vi.fn(async () => {});
        await expect(fetchSourceParcels(...args, { fetchImpl, sleep, log: m => logged.push(m) })).resolves.toEqual(collection);
        expect(fetchImpl).toHaveBeenCalledTimes(3);
        expect(new Set(fetchImpl.mock.calls.map(([url]) => url)).size).toBe(1);
        expect(logged.join('\n')).toMatch(/attempt 1\/3.*HTTP 502.*5000 ms/);
        expect(logged.join('\n')).toMatch(/attempt 2\/3.*HTTP 504.*15000 ms/);
        expect(logged.at(-1)).toMatch(/OK.*es-dgc-inspire-cp-wfs.*attempt 3\/3/);
    });

    it.each([
        new DOMException('request expired', 'TimeoutError'),
        new TypeError('fetch failed', { cause: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }) })
    ])('retries a timeout or connection failure: %s', async error => {
        const fetchImpl = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(reply(200));
        await expect(fetchSourceParcels(...args, { ...immediate, fetchImpl })).resolves.toEqual(collection);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('retains source, attempts, upstream status and count diagnostics on persistent failure', async () => {
        const counts = { matched: 190, returned: 190, received: 189 };
        const fetchImpl = vi.fn(async () => reply(502, {
            code: 'parcel-source-unavailable', error: 'Parcel GML has incomplete or inconsistent feature counts.',
            upstreamStatus: 200, parcelCounts: counts
        }));
        await expect(fetchSourceParcels(...args, { ...immediate, fetchImpl })).rejects.toMatchObject({
            sourceId: args[1], attempts: 3, status: 502, upstreamStatus: 200, parcelCounts: counts,
            message: expect.stringMatching(/es-dgc-inspire-cp-wfs.*attempt 3\/3.*matched=190.*returned=190.*received=189/)
        });
        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it('handles an HTML gateway response without leaking its body into diagnostics', async () => {
        const fetchImpl = vi.fn(async () => new Response('<html>private gateway detail</html>', { status: 504 }));
        await expect(fetchSourceParcels(...args, { ...immediate, fetchImpl })).rejects.toThrow(/HTTP 504/);
        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it.each([400, 401, 403, 404, 429])('does not retry HTTP %s', async status => {
        const fetchImpl = vi.fn(async () => reply(status));
        await expect(fetchSourceParcels(...args, { ...immediate, fetchImpl })).rejects.toMatchObject({ status, attempts: 1 });
        expect(fetchImpl).toHaveBeenCalledOnce();
    });

    it.each(['parcel-source-blocked', 'parcel-source-rate-limited'])('does not retry a gateway-wrapped %s', async code => {
        const fetchImpl = vi.fn(async () => reply(502, { code, error: 'Provider refused access.', upstreamStatus: code.endsWith('blocked') ? 403 : 429 }));
        await expect(fetchSourceParcels(...args, { ...immediate, fetchImpl })).rejects.toMatchObject({ code, attempts: 1 });
        expect(fetchImpl).toHaveBeenCalledOnce();
    });

    it('does not retry a client error even if its body uses the unavailable code', async () => {
        const fetchImpl = vi.fn(async () => reply(400, { code: 'parcel-source-unavailable' }));
        await expect(fetchSourceParcels(...args, { ...immediate, fetchImpl })).rejects.toMatchObject({ attempts: 1 });
        expect(fetchImpl).toHaveBeenCalledOnce();
    });

    it('respects Retry-After instead of hammering a cooling-down provider', async () => {
        const fetchImpl = vi.fn().mockResolvedValueOnce(reply(502, { code: 'parcel-source-unavailable' }, { 'Retry-After': '30' })).mockResolvedValueOnce(reply(200));
        const sleep = vi.fn(async () => {});
        await expect(fetchSourceParcels(...args, { fetchImpl, sleep })).resolves.toEqual(collection);
        expect(sleep.mock.calls[0][0]).toBe(30_000);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('fails at the overall deadline and aborts a stalled HTTP read', async () => {
        vi.useFakeTimers();
        const fetchImpl = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
        const pending = fetchSourceParcels(...args, { fetchImpl, maxElapsedMs: 1000 });
        const assertion = expect(pending).rejects.toMatchObject({ code: 'parcel-read-deadline', attempts: 1 });
        await vi.advanceTimersByTimeAsync(1000);
        await assertion;
        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
    });

    it('does not start another attempt when the cooldown exceeds the deadline', async () => {
        const fetchImpl = vi.fn(async () => reply(502, { code: 'parcel-source-unavailable', retryAfterSeconds: 3600 }));
        await expect(fetchSourceParcels(...args, { ...immediate, fetchImpl })).rejects.toMatchObject({ attempts: 1 });
        expect(fetchImpl).toHaveBeenCalledOnce();
    });

    it('does not retry programming or successful-response JSON errors', async () => {
        for (const fetchImpl of [vi.fn(async () => { throw new TypeError('bad caller argument'); }), vi.fn(async () => new Response('not JSON'))]) {
            await expect(fetchSourceParcels(...args, { ...immediate, fetchImpl })).rejects.toBeInstanceOf(Error);
            expect(fetchImpl).toHaveBeenCalledOnce();
        }
    });

    it('never treats a partial HTTP 200 collection as a successful parcel read', async () => {
        const fetchImpl = vi.fn(async () => reply(200, { ...collection, complete: false }));
        await expect(fetchSourceParcels(...args, { ...immediate, fetchImpl })).rejects.toMatchObject({
            code: 'parcel-source-unavailable', attempts: 3
        });
        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });
});
