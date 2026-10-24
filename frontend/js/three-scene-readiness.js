// Capture readiness is evidence about data, mesh completion and a rendered frame, never a timer
// or a nonzero mesh count (roads and proposals can render before existing buildings arrive).
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__threeSceneReadiness = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    function evaluate(state) {
        const reasons = [];
        if (!state.active || state.transitioning) reasons.push('scene-inactive');
        if (state.requireExisting !== false) {
            if (!state.existingVisible) reasons.push('existing-hidden');
            if (state.fetching || !state.outcome) reasons.push('existing-loading');
            else if (!['loaded', 'empty'].includes(state.outcome)) reasons.push(`existing-${state.outcome}`);
            if (!state.existingBuilt || !state.existingDataCurrent) reasons.push('existing-not-built');
            if (state.existingBuildFailures > 0) reasons.push('existing-build-failed');
        }
        if (state.building || state.incomplete || state.dirty) reasons.push('buildings-building');
        if (state.pendingModels > 0) reasons.push('models-loading');
        if (!state.frameCurrent) reasons.push('frame-pending');
        return { ready: reasons.length === 0, reasons, existingBuildings: state.existingBuildings || 0,
            outcome: state.outcome || null,
            failed: reasons.some(reason => ['existing-failed', 'existing-partial', 'existing-unsupported', 'existing-build-failed'].includes(reason)) };
    }
    function wait(read, { timeoutMs = 45000, signal } = {}) {
        return new Promise((resolve, reject) => {
            const started = Date.now();
            let timer;
            const stop = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
            const abort = () => { stop(); reject(Object.assign(new Error('Scene readiness wait aborted.'), { name: 'AbortError' })); };
            const check = () => {
                if (signal?.aborted) return abort();
                let state;
                try { state = read(); } catch (error) { stop(); reject(error); return; }
                if (state.ready) { stop(); resolve(state); return; }
                if (state.failed || Date.now() - started >= timeoutMs) {
                    stop();
                    reject(Object.assign(new Error(`3D scene is not ready: ${state.reasons.join(', ')}`), {
                        code: state.failed ? 'scene-load-failed' : 'scene-ready-timeout', readiness: state
                    }));
                    return;
                }
                timer = setTimeout(check, 50);
            };
            signal?.addEventListener('abort', abort, { once: true });
            check();
        });
    }
    return { evaluate, wait };
});
