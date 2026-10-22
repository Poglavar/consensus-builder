import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const REPO = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const SourceHealth = require(path.join(REPO, 'frontend/js/parcels/source-health.js'));
const fetchSource = readFileSync(path.join(REPO, 'frontend/js/parcels/fetch.js'), 'utf8');

afterEach(() => vi.useRealTimers());

function deferred() {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
}

function loadApp({ ensureBounds, fallback = vi.fn(), timeoutMs = 10 } = {}) {
    const window = {
        ParcelSourceHealth: SourceHealth,
        PARCEL_LOAD_TIMEOUT_MS: timeoutMs,
        getCurrentCityId: () => 'san_francisco',
        CityConfigManager: { hasParcelData: () => true },
        map: { getBounds: () => ({}) },
        CadastralParcelRepository: { ensureBounds },
        ParcelGroundFallback: { onGroundUnavailable: fallback },
        ParcelsState: { setIsFetchingParcels: vi.fn() },
        updateStatus: vi.fn(),
        ParcelSourceSettings: { clearFailure: vi.fn() },
        ParcelSourceInView: { latest: () => null },
        ParcelPreview: { show: vi.fn(), clear: vi.fn() }
    };
    vm.runInNewContext(fetchSource, {
        window, globalThis: window, AbortController, setTimeout, clearTimeout,
        URL, Promise, console: { error: vi.fn(), log: vi.fn(), warn: vi.fn() }
    });
    return window;
}

describe('parcel load deadlines', () => {
    it('rejects a transport that ignores abort at the deadline and aborts its signal', async () => {
        vi.useFakeTimers();
        let observedSignal;
        const window = loadApp({ ensureBounds: (_bounds, { signal }) => {
            observedSignal = signal;
            return new Promise(() => {});
        } });

        const pending = window.fetchParcelData({});
        await Promise.resolve();
        const rejected = expect(pending).rejects.toMatchObject({ name: 'TimeoutError', status: 504 });
        await vi.advanceTimersByTimeAsync(10);
        await rejected;
        expect(observedSignal.aborted).toBe(true);
    });

    it('progress restarts the deadline: a load that keeps reporting outlives the limit, silence still fails', async () => {
        vi.useFakeTimers();
        let touch;
        const alive = SourceHealth.withDeadline(async (_signal, activity) => {
            touch = activity.touch;
            await new Promise(resolve => setTimeout(resolve, 25));
            return 'ready';
        }, { timeoutMs: 10 });
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(8); touch();
        await vi.advanceTimersByTimeAsync(8); touch();
        await vi.advanceTimersByTimeAsync(8); touch();
        await vi.advanceTimersByTimeAsync(1);
        await expect(alive).resolves.toBe('ready');

        const silent = SourceHealth.withDeadline(async (_signal, activity) => {
            setTimeout(() => activity.touch(), 8);
            await new Promise(() => {});
        }, { timeoutMs: 10 });
        const rejected = expect(silent).rejects.toMatchObject({ name: 'TimeoutError', status: 504 });
        await vi.advanceTimersByTimeAsync(17);
        expect(vi.getTimerCount()).toBeGreaterThan(0);
        await vi.advanceTimersByTimeAsync(2);
        await rejected;
    });

    it('a viewport load that reports council progress is not timed out while it keeps reporting', async () => {
        vi.useFakeTimers();
        const fallback = vi.fn();
        const window = loadApp({ fallback, ensureBounds: (_bounds, { onProgress }) => new Promise(resolve => {
            let parcels = 0;
            const tick = () => {
                parcels += 250;
                onProgress({ phase: 'source-process', authority: 'Birmingham City Council', processedFeatures: parcels, totalFeatures: 1000 });
                if (parcels < 1000) setTimeout(tick, 8); else resolve({ features: [] });
            };
            setTimeout(tick, 8);
        }) });
        const pending = window.fetchParcelData({});
        await vi.advanceTimersByTimeAsync(40);
        await expect(pending).resolves.toMatchObject({ features: [] });
        expect(fallback).not.toHaveBeenCalled();
    });

    it('previewed parcels from a council import reach the preview layer, which is cleared once the view settles', async () => {
        const features = [{ type: 'Feature', id: 'GB-HMLR-BROWSER-v1-1', properties: { id: 'GB-HMLR-BROWSER-v1-1', preview: true },
            geometry: { type: 'Polygon', coordinates: [[[-1.9, 52.5], [-1.89, 52.5], [-1.89, 52.51], [-1.9, 52.5]]] } }];
        const window = loadApp({ timeoutMs: 1000, ensureBounds: async (_bounds, { onProgress }) => {
            onProgress({ phase: 'source-preview', authority: 'Birmingham City Council', features });
            return { features: [] };
        } });
        await expect(window.fetchParcelData({})).resolves.toMatchObject({ features: [] });
        expect(window.ParcelPreview.show).toHaveBeenCalledWith(features, expect.anything());
        expect(window.ParcelPreview.clear).toHaveBeenCalledOnce();
        expect(window.updateStatus).not.toHaveBeenCalledWith(expect.stringMatching(/undefined/), expect.anything());
    });

    it('propagates an external abort promptly without offering an outage fallback', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const reason = new Error('caller cancelled');
        const operation = vi.fn(signal => new Promise(() => {}));
        const pending = SourceHealth.withDeadline(operation, { timeoutMs: 1000, signal: controller.signal });
        const rejected = expect(pending).rejects.toBe(reason);
        controller.abort(reason);
        await rejected;
        expect(operation).toHaveBeenCalledOnce();
        expect(operation.mock.calls[0][0].aborted).toBe(true);
    });

    it('clears deadline timers and abort listeners after success, while bounding a slow body read', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const add = vi.spyOn(controller.signal, 'addEventListener');
        const remove = vi.spyOn(controller.signal, 'removeEventListener');
        const success = SourceHealth.withDeadline(async () => 'ready', { timeoutMs: 10, signal: controller.signal });
        await expect(success).resolves.toBe('ready');
        expect(add).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
        expect(vi.getTimerCount()).toBe(0);

        const body = SourceHealth.withDeadline(async () => {
            const response = { json: () => new Promise(() => {}) };
            return response.json();
        }, { timeoutMs: 10 });
        const bounded = expect(body).rejects.toMatchObject({ name: 'TimeoutError', status: 504 });
        await vi.advanceTimersByTimeAsync(10);
        await bounded;
    });

    it('reports a hung ground request once, resets fetch flags, and allows a retry', async () => {
        vi.useFakeTimers();
        const fallback = vi.fn();
        let calls = 0;
        const window = loadApp({ fallback, ensureBounds: () => {
            calls += 1;
            return calls === 1 ? new Promise(() => {}) : Promise.resolve({ features: [] });
        } });

        const first = window.fetchParcelData({});
        await Promise.resolve();
        const rejected = expect(first).rejects.toMatchObject({ name: 'TimeoutError', status: 504 });
        await vi.advanceTimersByTimeAsync(10);
        await rejected;
        expect(fallback).toHaveBeenCalledOnce();
        expect(fallback.mock.calls[0][0].error.message).not.toMatch(/no parcel register|no register is on record/i);
        expect(window._fetchParcelDataInProgress).toBe(false);
        expect(window.ParcelsState.setIsFetchingParcels).toHaveBeenLastCalledWith(false);
        await expect(window.fetchParcelData({})).resolves.toMatchObject({ features: [] });
        expect(calls).toBe(2);
        expect(fallback).toHaveBeenCalledOnce();
    });

    it('claims a replacement viewport before cancelling the older viewport', async () => {
        const old = deferred();
        const events = [];
        let claims = 0;
        const window = loadApp({ timeoutMs: 30000, ensureBounds: (_bounds, { signal }) => {
            const index = claims++;
            events.push(signal);
            if (index === 0) signal.addEventListener('abort', () => events.push('aborted-0'), { once: true });
            events.push(`claimed-${index}`);
            return index === 0 ? old.promise : Promise.resolve({ features: [] });
        } });
        const first = window.fetchParcelData({});
        await Promise.resolve();
        const second = window.fetchParcelData({});
        await expect(first).resolves.toBeNull();
        await expect(second).resolves.toMatchObject({ features: [] });
        expect(events[0].aborted).toBe(true);
        expect(events.indexOf('claimed-1')).toBeLessThan(events.indexOf('aborted-0'));
    });
});
