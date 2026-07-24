// Single-flight state for road finalization. Finishing can cross several async boundaries, but one
// user action must still produce exactly one finalization run; repeated keys/buttons share that run.
(function attachRoadFinalizationState(global) {
    'use strict';

    function createSingleFlightGate() {
        let activePromise = null;

        return {
            run(task) {
                if (activePromise) return activePromise;
                if (typeof task !== 'function') return Promise.reject(new TypeError('Finalization task must be a function'));

                const started = Promise.resolve().then(task);
                const tracked = started.finally(() => {
                    if (activePromise === tracked) activePromise = null;
                });
                activePromise = tracked;
                return tracked;
            },

            isRunning() {
                return activePromise !== null;
            }
        };
    }

    const api = { createSingleFlightGate };

    if (typeof window !== 'undefined') window.RoadFinalizationState = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
