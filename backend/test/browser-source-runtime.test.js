// Verifies browser transport choices, relay metadata, and shared cold-start query controls.
import { describe, expect, it, vi } from 'vitest';
import { createBrowserProviderFetch } from '../parcels/browser-source-runtime.js';
import { createBrowserParcelRuntime } from '../parcels/browser-source-runtime.js';

const response = (status = 200, headers = {}) => new Response('data', { status, headers });

describe('createBrowserProviderFetch', () => {
    it('omits browser credentials on direct requests', async () => {
        const fetchImpl = vi.fn(async () => response());
        const providerFetch = createBrowserProviderFetch({ id: 'source', adapter: 'wfs' }, { fetchImpl, relayBase: 'https://relay.test' });
        await providerFetch('https://provider.test/wfs');
        expect(fetchImpl).toHaveBeenCalledWith('https://provider.test/wfs', { credentials: 'omit' });
    });

    it('tries browser TLS before a relay even when Node needs an extra provider certificate', async () => {
        const fetchImpl = vi.fn(async () => response());
        const providerFetch = createBrowserProviderFetch({ id: 'source', adapter: 'arcgis', caCertificate: './certificates/provider.pem' },
            { fetchImpl, relayBase: 'https://relay.test' });
        await providerFetch('https://provider.test/query');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(fetchImpl.mock.calls[0][0]).toBe('https://provider.test/query');
    });

    it('keeps HTTP denials direct and relays transport failures', async () => {
        const fetchImpl = vi.fn().mockResolvedValueOnce(response(403)).mockRejectedValueOnce(new TypeError('CORS'))
            .mockResolvedValueOnce(response(200));
        const providerFetch = createBrowserProviderFetch({ id: 'source', adapter: 'wfs' }, { fetchImpl, relayBase: 'https://relay.test' });
        await expect(providerFetch('https://provider.test/denied')).resolves.toMatchObject({ status: 403 });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const result = await providerFetch('https://provider.test/unreachable', { method: 'GET' });
        expect(result.url).toBe('https://provider.test/unreachable');
        expect(fetchImpl).toHaveBeenCalledTimes(3);
        expect(fetchImpl.mock.calls[2][0]).toContain('/parcel-provider-relay/source');
    });

    it('restores a manual redirect carried as HTTP metadata without following it in fetch', async () => {
        const fetchImpl = vi.fn(async () => response(200, { 'x-parcel-upstream-status': '302',
            'x-parcel-upstream-location': 'https://provider.test/next', 'x-parcel-upstream-cookies': '["sid=one"]' }));
        const providerFetch = createBrowserProviderFetch({ id: 'source', adapter: 'kerala-entebhoomi' }, { fetchImpl, relayBase: 'https://relay.test' });
        const result = await providerFetch('https://provider.test/start', { redirect: 'manual' });
        expect(result.status).toBe(302);
        expect(result.headers.get('location')).toBe('https://provider.test/next');
        expect(result.headers.getSetCookie()).toEqual(['sid=one']);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('restores upstream cookies from relay metadata', async () => {
        const fetchImpl = vi.fn(async () => response(200, { 'x-parcel-upstream-cookies': JSON.stringify(['sid=one; Path=/', 'token=two; HttpOnly']) }));
        const providerFetch = createBrowserProviderFetch({ id: 'source', adapter: 'kerala-entebhoomi' }, { fetchImpl, relayBase: 'https://relay.test' });
        const result = await providerFetch('https://provider.test/data');
        expect(result.headers.getSetCookie()).toEqual(['sid=one; Path=/', 'token=two; HttpOnly']);
    });

    it('relays when a pinned parent or child snapshot ETag is not exposed', async () => {
        const endpoint = 'https://snapshots.test/child.geojson';
        const descriptor = { id: 'snap', adapter: 'geojson-snapshot', endpoint: 'https://snapshots.test/parent.geojson',
            expectedEtag: '"parent"', snapshots: [{ endpoint, expectedEtag: '"child"' }] };
        const fetchImpl = vi.fn().mockResolvedValueOnce(response(200)).mockResolvedValueOnce(response(200, { etag: '"child"' }))
            .mockResolvedValueOnce(response(200));
        const providerFetch = createBrowserProviderFetch(descriptor, { fetchImpl, relayBase: 'https://relay.test' });
        const relayed = await providerFetch(endpoint);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(fetchImpl.mock.calls[1][0]).toContain('/parcel-provider-relay/snap');
        expect(relayed.url).toBe(endpoint);
        await providerFetch('https://snapshots.test/parent.geojson');
        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });
});

describe('createBrowserParcelRuntime', () => {
    it('broadcasts cached adapter progress to active queries for the same source and unsubscribes at settlement', async () => {
        const subscriptions = [];
        const gates = [];
        const sourceId = 'custom.test';
        const customDescriptor = { id: sourceId, adapter: 'test', endpoint: 'https://provider.test/data' };
        const runtime = createBrowserParcelRuntime({ factories: { test: async (_descriptor, { onProgress }) => {
            subscriptions.push(onProgress);
            return { queryBounds: async () => {
                const gate = {};
                gate.promise = new Promise((resolve, reject) => { gate.resolve = resolve; gate.reject = reject; });
                gates.push(gate);
                return gate.promise;
            } };
        } } });
        const firstProgress = vi.fn();
        const secondProgress = vi.fn();
        const first = runtime.query(sourceId, 'queryBounds', [1], customDescriptor, { onProgress: firstProgress });
        await vi.waitFor(() => expect(gates).toHaveLength(1));
        const second = runtime.query(sourceId, 'queryBounds', [2], customDescriptor, { onProgress: secondProgress });
        await vi.waitFor(() => expect(gates).toHaveLength(2));

        subscriptions[0]({ phase: 'downloading', loaded: 1 });
        expect(firstProgress).toHaveBeenCalledWith({ phase: 'downloading', loaded: 1 });
        expect(secondProgress).toHaveBeenCalledWith({ phase: 'downloading', loaded: 1 });

        gates[0].resolve({ complete: true, features: [1] });
        await expect(first).resolves.toMatchObject({ complete: true });
        subscriptions[0]({ phase: 'after-first-settlement' });
        expect(firstProgress).toHaveBeenCalledTimes(1);
        expect(secondProgress).toHaveBeenCalledTimes(2);

        gates[1].resolve({ complete: true, features: [2] });
        await expect(second).resolves.toMatchObject({ complete: true });
        subscriptions[0]({ phase: 'after-all-settled' });
        expect(firstProgress).toHaveBeenCalledTimes(1);
        expect(secondProgress).toHaveBeenCalledTimes(2);
    });

    it('passes the request signal to the adapter and refuses an already-cancelled request', async () => {
        const seen = [];
        const customDescriptor = { id: 'custom.signal', adapter: 'test', endpoint: 'https://provider.test/data' };
        const runtime = createBrowserParcelRuntime({ factories: { test: async () => ({
            queryBounds: async (bounds, { signal }) => { seen.push([bounds, signal]); return { complete: true, features: [] }; }
        }) } });
        const controller = new AbortController();
        await runtime.query(customDescriptor.id, 'queryBounds', [[0, 0, 1, 1]], customDescriptor, { signal: controller.signal });
        expect(seen).toHaveLength(1);
        expect(seen[0][0]).toEqual([0, 0, 1, 1]);
        expect(seen[0][1]).toBe(controller.signal);
        controller.abort();
        await expect(runtime.query(customDescriptor.id, 'queryBounds', [[0, 0, 1, 1]], customDescriptor, { signal: controller.signal }))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(seen).toHaveLength(1);
    });

    it('isolates source progress and swallows observer errors while still unsubscribing on query errors', async () => {
        const broadcasters = new Map();
        let rejectQuery;
        let resolveBQueryStarted;
        const bQueryStarted = new Promise(resolve => { resolveBQueryStarted = resolve; });
        let resolveBQuery;
        const bQueryGate = new Promise(resolve => { resolveBQuery = resolve; });
        const sourceA = { id: 'custom.a', adapter: 'test', endpoint: 'https://provider.test/a' };
        const sourceB = { id: 'custom.b', adapter: 'test', endpoint: 'https://provider.test/b' };
        const runtime = createBrowserParcelRuntime({ factories: { test: async (descriptor, { onProgress }) => {
            broadcasters.set(descriptor.id, onProgress);
            return { queryBounds: async () => descriptor.id === sourceA.id
                ? new Promise((_resolve, reject) => { rejectQuery = reject; })
                : (resolveBQueryStarted(), bQueryGate) };
        } } });
        const throwingObserver = vi.fn(() => { throw new Error('observer failed'); });
        const pendingA = runtime.query(sourceA.id, 'queryBounds', [], sourceA, { onProgress: throwingObserver });
        await vi.waitFor(() => expect(rejectQuery).toEqual(expect.any(Function)));
        const pendingBProgress = vi.fn();
        const pendingB = runtime.query(sourceB.id, 'queryBounds', [], sourceB, { onProgress: pendingBProgress });
        await bQueryStarted;

        broadcasters.get(sourceA.id)({ phase: 'downloading', loadedBytes: 1, totalBytes: 4 });
        expect(throwingObserver).toHaveBeenCalledTimes(1);
        expect(pendingBProgress).not.toHaveBeenCalled();
        rejectQuery(new Error('query failed'));
        await expect(pendingA).rejects.toThrow('query failed');
        broadcasters.get(sourceA.id)({ phase: 'processing', processedFeatures: 1, totalFeatures: 3 });
        expect(throwingObserver).toHaveBeenCalledTimes(1);

        resolveBQuery({ complete: true, features: [] });
        await expect(pendingB).resolves.toMatchObject({ complete: true });
    });

    it('coalesces cold adapter creation and applies its query cap before concurrent calls run', async () => {
        let createCount = 0, active = 0, peak = 0;
        const pendingQueries = [];
        const sourceId = 'custom.test';
        const customDescriptor = { id: sourceId, adapter: 'test', endpoint: 'https://provider.test/data', maxConcurrentQueries: 1 };
        const runtime = createBrowserParcelRuntime({ factories: { test: async () => {
            createCount++;
            return { queryBounds: async () => {
                active++;
                peak = Math.max(peak, active);
                const gate = {};
                gate.promise = new Promise(resolve => { gate.resolve = resolve; });
                pendingQueries.push(gate);
                const result = await gate.promise;
                active--;
                return result;
            } };
        } } });

        const calls = Array.from({ length: 6 }, (_, index) => runtime.query(sourceId, 'queryBounds', [index], customDescriptor));
        await vi.waitFor(() => expect(pendingQueries).toHaveLength(1));
        expect(createCount).toBe(1);
        for (let index = 0; index < calls.length; index++) {
            pendingQueries[index].resolve({ complete: true, features: [index] });
            if (index + 1 < calls.length) await vi.waitFor(() => expect(pendingQueries).toHaveLength(index + 2));
        }
        await expect(Promise.all(calls)).resolves.toEqual(Array.from({ length: 6 }, (_, index) => ({ complete: true, features: [index] })));
        expect(createCount).toBe(1);
        expect(peak).toBe(1);
    });
});
