// Tests the classic-script worker RPC client without launching a browser or a real Worker.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../frontend/js/parcels/browser-client.js', import.meta.url), 'utf8');

class FakeWorker {
    constructor(url, options) {
        this.url = String(url);
        this.options = options;
        this.listeners = new Map();
        this.messages = [];
        this.terminated = false;
        FakeWorker.instances.push(this);
    }
    addEventListener(type, callback) {
        const callbacks = this.listeners.get(type) || [];
        callbacks.push(callback);
        this.listeners.set(type, callbacks);
    }
    postMessage(message) { this.messages.push(message); }
    emit(type, event = {}) { for (const callback of this.listeners.get(type) || []) callback(event); }
    terminate() { this.terminated = true; }
}
FakeWorker.instances = [];

function boot(scriptVersion = '') {
    FakeWorker.instances = [];
    const listeners = new Map();
    const choiceForCity = vi.fn(() => ({ endpoint: 'https://example.test', layer: 'parcels' }));
    const window = {
        Worker: FakeWorker,
        document: { baseURI: 'https://app.example.test/', currentScript: scriptVersion ? { src: `https://app.example.test/js/parcels/browser-client.js${scriptVersion}` } : null },
        ParcelSourceSettings: { choiceForCity },
        CityConfigManager: { getCurrentCityId: () => 'city-a' },
        getBackendBase: () => 'https://api.example.test',
        addEventListener: (type, callback) => {
            const callbacks = listeners.get(type) || [];
            callbacks.push(callback);
            listeners.set(type, callbacks);
        }
    };
    vm.runInContext(source, vm.createContext({ window, URL, setTimeout, clearTimeout, Map, Promise, Error, Object, String }));
    return { client: window.BrowserParcelSources, listeners, choiceForCity };
}

afterEach(() => vi.useRealTimers());

describe('browser parcel worker client', () => {
    it('sends unique request IDs with source, method, arguments and city, then resolves the matching response', async () => {
        const { client } = boot();
        const first = client.queryBounds('source-a', [-79.4, 43.6, -79.3, 43.7], { city: 'toronto' });
        const second = client.queryIds('source-a', ['A-1'], { city: 'toronto' });
        const worker = FakeWorker.instances[0];

        expect(worker.url).toBe('https://app.example.test/assets/parcel-adapters/worker.js');
        expect(worker.options).toEqual({ type: 'module' });
        expect(worker.messages).toEqual([
            { id: 1, sourceId: 'source-a', method: 'queryBounds', args: [[-79.4, 43.6, -79.3, 43.7]], customDescriptor: undefined, relayBase: 'https://api.example.test' },
            { id: 2, sourceId: 'source-a', method: 'queryIds', args: [['A-1']], customDescriptor: undefined, relayBase: 'https://api.example.test' }
        ]);

        worker.emit('message', { data: { id: 2, result: { complete: true, absentIds: [] } } });
        worker.emit('message', { data: { id: 1, result: { complete: true, features: [] } } });
        await expect(first).resolves.toEqual({ complete: true, features: [] });
        await expect(second).resolves.toEqual({ complete: true, absentIds: [] });
    });

    it('versions the worker URL with the executing frontend script', async () => {
        const { client } = boot('?v=release-a');
        const pending = client.queryIds('source-a', ['A-1']);
        const worker = FakeWorker.instances[0];
        expect(worker.url).toBe('https://app.example.test/assets/parcel-adapters/worker.js?v=release-a');
        worker.emit('message', { data: { id: 1, result: { complete: true, features: [] } } });
        await pending;
    });

    it('uses the explicit city custom-source descriptor and propagates asynchronous worker errors', async () => {
        const { client, choiceForCity } = boot();
        const pending = client.queryPoint('custom.city-a', [-79.38, 43.65], { city: 'city-a' });
        const worker = FakeWorker.instances[0];
        expect(choiceForCity).toHaveBeenCalledWith('city-a', expect.any(Object));
        expect(worker.messages[0]).toMatchObject({
            id: 1, sourceId: 'custom.city-a', method: 'queryPoint', args: [[-79.38, 43.65]],
            customDescriptor: { endpoint: 'https://example.test', layer: 'parcels' }, relayBase: 'https://api.example.test'
        });

        worker.emit('message', { data: { id: 1, error: { message: 'provider rate limited', code: 'parcel-source-rate-limited', status: 429 } } });
        await expect(pending).rejects.toMatchObject({ message: 'provider rate limited', code: 'parcel-source-rate-limited', status: 429 });
        expect(worker.terminated).toBe(false);
    });

    it('terminates and rejects pending requests after a worker runtime error', async () => {
        const { client } = boot();
        const first = client.queryGeometry('source-a', { type: 'Polygon', coordinates: [] });
        const second = client.queryIds('source-a', ['A-1']);
        const worker = FakeWorker.instances[0];

        worker.emit('error');
        await expect(first).rejects.toThrow(/worker failed to load or process data/);
        await expect(second).rejects.toThrow(/worker failed to load or process data/);
        expect(worker.terminated).toBe(true);
    });

    it('times out stalled requests, terminates the worker, and rejects pending work', async () => {
        vi.useFakeTimers();
        const { client } = boot();
        const pending = client.queryIds('source-a', ['A-1']);
        const worker = FakeWorker.instances[0];

        const rejection = expect(pending).rejects.toMatchObject({ code: 'parcel-source-unavailable', status: 504 });
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
        await rejection;
        expect(worker.terminated).toBe(true);
    });

    it('rejects pending requests on pagehide and creates a fresh worker afterward', async () => {
        const { client, listeners } = boot();
        const pending = client.queryIds('source-a', ['A-1']);
        const firstWorker = FakeWorker.instances[0];

        for (const callback of listeners.get('pagehide') || []) callback();
        await expect(pending).rejects.toThrow('Parcel page closed.');
        expect(firstWorker.terminated).toBe(true);

        const next = client.queryBounds('source-a', [0, 0, 1, 1]);
        expect(FakeWorker.instances).toHaveLength(2);
        expect(FakeWorker.instances[1].messages[0].id).toBe(2);
        FakeWorker.instances[1].emit('message', { data: { id: 2, result: { complete: true, features: [] } } });
        await expect(next).resolves.toMatchObject({ complete: true });
    });
});
