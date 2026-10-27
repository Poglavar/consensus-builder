// Release comparison and request state, independent of the page and its editors.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ReleaseUpdates = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const INTERVAL_MS = 5 * 60 * 1000;
    function validBuild(value) {
        return !!value && typeof value.buildId === 'string' && /^deploy-\d+$/.test(value.buildId)
            && (typeof value.buildNumber === 'number' || (typeof value.buildNumber === 'string' && /^\d+$/.test(value.buildNumber)))
            && Number.isSafeInteger(Number(value.buildNumber)) && Number(value.buildNumber) > 0
            && value.buildId === `deploy-${Number(value.buildNumber)}`;
    }
    function readRelease(value) {
        if (value?.version !== 1 || value.component !== 'urbangametheory-frontend' || !validBuild(value)
            || typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt))) throw new Error('Invalid frontend release');
        return { buildId: value.buildId, buildNumber: Number(value.buildNumber), generatedAt: value.generatedAt };
    }
    function createChecker({ running, request, now = Date.now, changed = () => {} }) {
        const deployed = validBuild(running);
        let state = { status: deployed ? 'idle' : 'development', latest: null, available: false, checkedAt: null };
        let pending = null;
        function publish(patch) { state = { ...state, ...patch }; changed({ ...state }); }
        function check() {
            if (!deployed) return Promise.resolve({ ...state });
            if (pending) return pending;
            publish({ status: 'checking' });
            pending = Promise.resolve().then(request).then(readRelease).then(latest => {
                // Ignore an older edge response. Deployment counters also increase for rollbacks.
                if (latest.buildNumber < Number(running.buildNumber) || latest.buildNumber < (state.latest?.buildNumber || 0)) {
                    throw new Error('Older frontend release');
                }
                const available = latest.buildNumber > Number(running.buildNumber);
                publish({ status: available ? 'available' : 'current', latest, available, checkedAt: now() });
            }).catch(() => {
                // A failed check must not claim the tab is current or erase a known update.
                publish({ status: 'error', checkedAt: now() });
            }).then(() => { pending = null; return { ...state }; });
            return pending;
        }
        return { check, snapshot: () => ({ ...state }), deployed };
    }
    return { INTERVAL_MS, validBuild, readRelease, createChecker };
});
