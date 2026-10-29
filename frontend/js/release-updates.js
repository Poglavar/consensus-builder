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
    // "Update now" reloads the tab. The address already carries the view and camera; this record
    // carries what the click stack had open, for this tab only (sessionStorage), and is read once.
    // Only point-located sections can be found again under the saved point; a plan, agreement or
    // multi-parcel selection is not recorded.
    const RESUME_KEY = 'cb.updateResume';
    const RESUME_MAX_AGE_MS = 2 * 60 * 1000;
    const RESUMABLE = new Set(['designs', 'built', 'permitted', 'formed', 'parcels']);
    function resumeRecord({ mode, pathname, stack, selectedInstance, point, now }) {
        const selected = {};
        const expandable = stack && RESUMABLE.has(stack.selectedKind);
        if (expandable) {
            for (const section of stack.sections || []) {
                if (!RESUMABLE.has(section.kind)) continue;
                const instance = selectedInstance(stack, section.kind);
                if (instance && instance.id != null) selected[section.kind] = String(instance.id);
            }
        }
        const lat = Number(point?.lat), lng = Number(point?.lng);
        return { version: 1, savedAt: now, pathname, mode: mode || '2d',
            point: Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null,
            selected, selectedKind: expandable ? stack.selectedKind : null, expanded: expandable ? stack.expanded || null : null };
    }
    // A record from another page, an old session or another format is ignored, never half-applied.
    function readResume(raw, { now, pathname }) {
        let value;
        try { value = JSON.parse(raw); } catch (_) { return null; }
        if (!value || value.version !== 1 || typeof value.savedAt !== 'number' || now - value.savedAt > RESUME_MAX_AGE_MS
            || now < value.savedAt || value.pathname !== pathname || !value.selected || typeof value.selected !== 'object') return null;
        const selected = Object.fromEntries(Object.entries(value.selected)
            .filter(([kind, id]) => RESUMABLE.has(kind) && typeof id === 'string' && id));
        const point = Array.isArray(value.point) && value.point.length === 2 && value.point.every(Number.isFinite) ? value.point : null;
        if (value.mode === '2d' && Object.keys(selected).length && !point) return null;
        return { mode: typeof value.mode === 'string' ? value.mode : '2d', point, selected,
            selectedKind: RESUMABLE.has(value.selectedKind) ? value.selectedKind : null,
            expanded: RESUMABLE.has(value.expanded) ? value.expanded : null };
    }
    return { INTERVAL_MS, RESUME_KEY, RESUME_MAX_AGE_MS, validBuild, readRelease, createChecker, resumeRecord, readResume };
});
