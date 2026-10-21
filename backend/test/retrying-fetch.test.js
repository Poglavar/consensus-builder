import { describe, expect, it, vi } from 'vitest';
import { fetchLensMembers } from '../agents/lens-directory-client.js';
import { createRetryingFetch } from '../utils/retrying-fetch.js';

const response = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
});
const retryOptions = () => ({ wait: vi.fn(async () => {}), log: vi.fn() });

describe('shared transient fetch retries', () => {
    it('retries GET transient HTTP responses with bounded exponential delays', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(new Response('busy', { status: 429 }))
            .mockResolvedValueOnce(new Response('upstream', { status: 502 }))
            .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
            .mockResolvedValueOnce(response({ ok: true }));
        const options = retryOptions();
        const retryFetch = createRetryingFetch({ fetchImpl, ...options });

        await expect(retryFetch('https://rpc.example.test/path?key=url-secret')).resolves.toMatchObject({ status: 200 });
        expect(fetchImpl).toHaveBeenCalledTimes(4);
        expect(options.wait.mock.calls.map(([duration]) => duration)).toEqual([1000, 2000, 4000]);
        expect(options.log).toHaveBeenCalledTimes(3);
        const retryLog = options.log.mock.calls.flat().join('\n');
        expect(retryLog).not.toContain('url-secret');
        expect(retryLog).not.toContain('busy');
        expect(retryLog).not.toContain('upstream');
        expect(retryLog).not.toContain('unavailable');
    });

    it('does not retry deterministic HTTP 400 or 413', async () => {
        for (const status of [400, 413]) {
            const fetchImpl = vi.fn().mockResolvedValue(new Response('deterministic failure', { status }));
            const retryFetch = createRetryingFetch({ fetchImpl, wait: vi.fn(), log: vi.fn() });
            await expect(retryFetch('https://example.test/resource')).resolves.toMatchObject({ status });
            expect(fetchImpl).toHaveBeenCalledTimes(1);
        }
    });

    it('retries POST only after explicit idempotent opt-in and reuses the original body', async () => {
        const body = '{"chainRef":{"chainType":"solana","tokenId":"token-secret"}}';
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(new Response('gateway failed', { status: 502 }))
            .mockResolvedValueOnce(response({ id: 17 }));
        const options = retryOptions();
        const retryFetch = createRetryingFetch({ ...options, fetchImpl });

        await retryFetch('https://example.test/mirror', { method: 'POST', body });
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        fetchImpl.mockReset()
            .mockResolvedValueOnce(new Response('gateway failed', { status: 502 }))
            .mockResolvedValueOnce(response({ id: 17 }));
        const idempotentPost = createRetryingFetch({ ...options, fetchImpl, retryMethods: ['POST'] });
        await idempotentPost('https://example.test/mirror?key=url-secret', { method: 'POST', body });

        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(fetchImpl.mock.calls.map(([, init]) => init.body)).toEqual([body, body]);
        const retryLog = options.log.mock.calls.flat().join('\n');
        expect(retryLog).not.toContain('url-secret');
        expect(retryLog).not.toContain('token-secret');
        expect(retryLog).not.toContain('gateway failed');
    });

    it('bounds network retries and stops on caller abort', async () => {
        const fetchImpl = vi.fn().mockRejectedValue(new TypeError('socket reset'));
        const retryFetch = createRetryingFetch({ fetchImpl, wait: vi.fn(async () => {}), log: vi.fn() });
        await expect(retryFetch('https://example.test/resource')).rejects.toThrow('socket reset');
        expect(fetchImpl).toHaveBeenCalledTimes(4);

        const controller = new AbortController();
        const abortFetch = vi.fn().mockResolvedValue(new Response('busy', { status: 429 }));
        const wait = vi.fn(async (_duration, _value, options) => {
            controller.abort(new Error('caller cancelled'));
            options.signal.throwIfAborted();
        });
        const abortingRetry = createRetryingFetch({ fetchImpl: abortFetch, wait, log: vi.fn() });
        await expect(abortingRetry('https://example.test/resource', { signal: controller.signal }))
            .rejects.toMatchObject({ message: 'caller cancelled' });
        expect(abortFetch).toHaveBeenCalledTimes(1);
    });

    it('bounds each hanging attempt with a timeout', async () => {
        const fetchImpl = vi.fn((_url, { signal }) => new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }));
        const retryFetch = createRetryingFetch({ fetchImpl, timeoutMs: 2, wait: async () => {}, log: vi.fn() });

        await expect(retryFetch('https://example.test/resource')).rejects.toMatchObject({ name: 'TimeoutError' });
        expect(fetchImpl).toHaveBeenCalledTimes(4);
    });

    it('retries the lens-directory GET through its fetch injection without exposing the URL', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(new Response('upstream', { status: 502 }))
            .mockResolvedValueOnce(response({ members: [{ key: 'lens-key' }] }));
        const options = retryOptions();

        await expect(fetchLensMembers({ apiBase: 'https://api.example.test', fetchImpl, retryOptions: options }))
            .resolves.toEqual([{ key: 'lens-key' }]);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        const retryLog = options.log.mock.calls.flat().join('\n');
        expect(retryLog).not.toContain('api.example.test');
        expect(retryLog).not.toContain('upstream');
    });
});
