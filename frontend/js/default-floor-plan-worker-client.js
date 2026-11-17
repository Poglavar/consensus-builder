// Run one layout calculation off the UI thread, with cancellation and a computation watchdog.
(function (global) {
    'use strict';
    function create({ spawn, timeoutMs = 10000, setTimer = setTimeout, clearTimer = clearTimeout }) {
        let worker = null, pending = null, sequence = 0;
        function stop(error) {
            worker?.terminate(); worker = null;
            if (pending) { const request = pending; pending = null; clearTimer(request.timer); request.reject(error); }
        }
        function dispose() { stop(Object.assign(new Error('Layout calculation cancelled.'), { name: 'AbortError' })); }
        function plan(feature, context) {
            if (pending) return Promise.reject(new Error('A layout calculation is already in progress.'));
            return new Promise((resolve, reject) => {
                if (!worker) {
                    try { worker = spawn(); } catch (error) { reject(error); return; }
                    const active = worker;
                    worker.onmessage = ({ data }) => {
                        if (!pending || data?.id !== pending.id) return;
                        const request = pending; pending = null; clearTimer(request.timer);
                        if (data.error) request.reject(Object.assign(new Error(data.error.message), { name: data.error.name || 'Error' }));
                        else request.resolve(data.result);
                    };
                    worker.onerror = event => { if (worker !== active) return; event.preventDefault?.(); stop(new Error(event.message || 'Layout worker failed.')); };
                }
                const id = ++sequence;
                pending = { id, resolve, reject, timer: setTimer(() => stop(new Error('Layout calculation exceeded its time limit.')), timeoutMs) };
                const { turf, generator, cache, ...input } = context;
                try { worker.postMessage({ id, feature, context: input }); } catch (error) { stop(error); }
            });
        }
        return { plan, dispose, get pending() { return !!pending; } };
    }
    const api = { create };
    global.__defaultFloorPlanWorker = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
