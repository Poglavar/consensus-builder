// Worker client makes provider reads independent of the parcel API while keeping parsing off the UI.
(function (global) {
    'use strict';
    const version = global.document.currentScript ? new URL(global.document.currentScript.src, global.document.baseURI).search : '';
    let worker, sequence = 0;
    const pending = new Map();
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
            pending.delete(data.id); clearTimeout(request.timer);
            if (data.error) request.reject(Object.assign(new Error(data.error.message), data.error));
            else request.resolve(data.result);
        });
        worker.addEventListener('error', () => reset(new Error('Parcel adapter worker failed to load or process data.')));
        worker.addEventListener('messageerror', () => reset(new Error('Parcel adapter worker returned unreadable data.')));
        return worker;
    }
    function query(sourceId, method, args, { city } = {}) {
        const active = getWorker(), id = ++sequence;
        const customDescriptor = sourceId.startsWith('custom.')
            ? global.ParcelSourceSettings?.choiceForCity?.(city || global.CityConfigManager?.getCurrentCityId?.(), global) : undefined;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reset(Object.assign(new Error('Parcel provider processing timed out.'), { code: 'parcel-source-unavailable', status: 504 }));
            }, 10 * 60 * 1000);
            pending.set(id, { resolve, reject, timer });
            try { active.postMessage({ id, sourceId, method, args, customDescriptor,
                relayBase: global.getBackendBase?.() }); }
            catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
        });
    }
    global.BrowserParcelSources = Object.freeze({ query,
        queryBounds: (sourceId, bounds, options) => query(sourceId, 'queryBounds', [bounds], options),
        queryIds: (sourceId, ids, options) => query(sourceId, 'queryIds', [ids], options),
        queryGeometry: (sourceId, geometry, options) => query(sourceId, 'queryGeometry', [geometry], options),
        queryPoint: (sourceId, point, options) => query(sourceId, 'queryPoint', [point], options) });
    global.addEventListener?.('pagehide', () => reset(new Error('Parcel page closed.')));
})(typeof window !== 'undefined' ? window : globalThis);
