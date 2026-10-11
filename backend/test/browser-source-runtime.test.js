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
