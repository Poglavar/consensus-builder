// Worker client makes provider reads independent of the parcel API while keeping parsing off the UI.
(function (global) {
    'use strict';
    const version = global.document.currentScript ? new URL(global.document.currentScript.src, global.document.baseURI).search : '';
    let worker, sequence = 0;
    const pending = new Map();
    // A request is alive while the worker reports progress on it; this much silence means the
    // worker is stuck, and the whole worker is reset. A council import is never cut short by it.
    const REQUEST_SILENCE_MS = 10 * 60 * 1000;
    function reset(error) {
        worker?.terminate(); worker = null;
        for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
        pending.clear();
    }
    function getWorker() {
        if (worker) return worker;
        if (typeof global.Worker !== 'function') throw new Error('Parcel adapters require Web Worker support.');
        worker = new global.Worker(new URL(`assets/parcel-adapters/worker.js${version}`, global.document.baseURI), { type: 'module' });
        worker.addEventListener('message', ({ data }) => {
            const request = pending.get(data?.id);
            if (!request) return;
            if (data.progress) {
                clearTimeout(request.timer);
                request.timer = setTimeout(request.expire, REQUEST_SILENCE_MS);
                try { request.onProgress?.(data.progress); } catch (_) { /* Keep the worker request alive. */ }
                return;
            }
            pending.delete(data.id); clearTimeout(request.timer);
            if (data.error) request.reject(Object.assign(new Error(data.error.message), data.error));
            else request.resolve(data.result);
        });
        worker.addEventListener('error', () => reset(new Error('Parcel adapter worker failed to load or process data.')));
        worker.addEventListener('messageerror', () => reset(new Error('Parcel adapter worker returned unreadable data.')));
        return worker;
    }
    // An aborted signal rejects with its reason at once and tells the worker to stop the request.
    function query(sourceId, method, args, { city, onProgress, signal } = {}) {
        if (signal?.aborted) return Promise.reject(signal.reason);
        const active = getWorker(), id = ++sequence;
        const customDescriptor = sourceId.startsWith('custom.')
            ? global.ParcelSourceSettings?.choiceForCity?.(city || global.CityConfigManager?.getCurrentCityId?.(), global) : undefined;
        return new Promise((resolve, reject) => {
            const expire = () => {
                reset(Object.assign(new Error('Parcel provider processing timed out.'), { code: 'parcel-source-unavailable', status: 504 }));
            };
            const request = { expire, timer: setTimeout(expire, REQUEST_SILENCE_MS) };
            const cancel = () => {
                if (!pending.has(id)) return;
                pending.delete(id); clearTimeout(request.timer);
                try { active.postMessage({ cancel: id }); } catch (_) { /* A failed worker has already dropped the request. */ }
                reject(signal.reason);
            };
            const settle = done => value => { signal?.removeEventListener('abort', cancel); done(value); };
            const trackProgress = typeof onProgress === 'function';
            Object.assign(request, { resolve: settle(resolve), reject: settle(reject), onProgress: trackProgress ? onProgress : undefined });
            pending.set(id, request);
            signal?.addEventListener('abort', cancel, { once: true });
            // Progress is only requested when someone listens; the silence limit needs it too.
            try { active.postMessage({ id, sourceId, method, args, customDescriptor,
                relayBase: global.getBackendBase?.(), trackProgress: true }); }
            catch (error) { clearTimeout(request.timer); pending.delete(id); signal?.removeEventListener('abort', cancel); reject(error); }
        });
    }
    global.BrowserParcelSources = Object.freeze({ query,
        queryBounds: (sourceId, bounds, options) => query(sourceId, 'queryBounds', [bounds], options),
        queryIds: (sourceId, ids, options) => query(sourceId, 'queryIds', [ids], options),
        queryGeometry: (sourceId, geometry, options) => query(sourceId, 'queryGeometry', [geometry], options),
        queryPoint: (sourceId, point, options) => query(sourceId, 'queryPoint', [point], options),
        // The source's catalog wording and links, read from the bundled catalog (no server request).
        describe: (sourceId, options) => query(sourceId, 'describe', [], options) });
    // One cell of a URL building source (`building.<base64url>`), read by the same worker straight from
    // the source's service: { kind: 'near' | 'footprints', bbox } → the answer POST /buildings/cell gives.
    global.BrowserBuildingSources = Object.freeze({
        readCell: (sourceId, { kind, bbox }, options) => query(sourceId, 'buildingCell', [{ kind, bbox }], options) });
    global.addEventListener?.('pagehide', () => reset(new Error('Parcel page closed.')));
})(typeof window !== 'undefined' ? window : globalThis);
