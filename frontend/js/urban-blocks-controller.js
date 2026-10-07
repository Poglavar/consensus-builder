// Testable lifecycle for the block view: bounded viewport loading, reusable coverage, cancellation,
// and stale-response protection. Rendering and network/worker I/O are injected by the UI adapter.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.UrbanBlocksController = api;
})(typeof self !== 'undefined' ? self : null, function () {
    'use strict';
    const contains = (outer, inner) => outer && inner[0] >= outer[0] && inner[1] >= outer[1]
        && inner[2] <= outer[2] && inner[3] <= outer[3];

    function requestBounds({ bbox, zoom }) {
        if (zoom < 15 || !Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite)) return null;
        const [w, s, e, n] = bbox;
        const dx = (e - w) * 0.25, dy = (n - s) * 0.25;
        if (e <= w || n <= s || (e - w) * 1.5 > 0.06 || (n - s) * 1.5 > 0.06) return null;
        // A wrapped antimeridian view must be moved to one side before making a planar request.
        if (w - dx < -180 || e + dx > 180 || s - dy < -90 || n + dy > 90) return null;
        return [w - dx, s - dy, e + dx, n + dy];
    }

    function create({ fetchRoads, detect, onChange }) {
        let version = 0, pending = null;
        let state = { enabled: false, phase: 'off', blocks: null, coverage: null, roadCount: 0, error: '' };
        const emit = patch => { state = { ...state, ...patch }; onChange(state); };
        function cancel() { version++; pending?.abort(); pending = null; }
        function setEnabled(enabled) {
            cancel();
            emit({ enabled, phase: enabled ? 'idle' : 'off', blocks: null, coverage: null, error: '', roadCount: 0 });
        }
        async function refresh(viewport, force = false) {
            if (!state.enabled) return;
            const bbox = requestBounds(viewport);
            if (!bbox) {
                cancel();
                emit({ phase: 'zoom', blocks: null, coverage: null, roadCount: 0 });
                return;
            }
            if (!force && state.phase === 'ready' && contains(state.coverage, viewport.bbox)) return;
            return loadBounds(bbox);
        }
        async function loadBounds(bbox) {
            if (!state.enabled) return;
            cancel();
            const ownVersion = version;
            const controller = new AbortController();
            pending = controller;
            const current = () => state.enabled && version === ownVersion;
            emit({ phase: 'roads', blocks: null, coverage: null, error: '', roadCount: 0 });
            try {
                const roads = await fetchRoads(bbox, controller.signal);
                if (!current()) return;
                if (roads.partial || roads.truncated) throw new Error('OSM road data is incomplete. Retry or zoom in.');
                emit({ phase: 'blocks', roadCount: roads.features.length });
                const blocks = await detect(roads, bbox, controller.signal);
                if (!current()) return;
                emit({ phase: 'ready', blocks, coverage: bbox });
            } catch (error) {
                if (!current()) return;
                emit({ phase: 'error', blocks: null, coverage: null, error: error.message });
            } finally {
                if (current()) pending = null;
            }
        }
        return { setEnabled, refresh, loadBounds, snapshot: () => state };
    }
    return { create, requestBounds };
});
