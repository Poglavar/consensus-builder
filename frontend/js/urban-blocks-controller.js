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

    // `extendRoads` adds what the map applies on top of OSM (proposed streets) to the fetched roads;
    // `redetect` reruns detection on the same fetched roads when that addition changes.
    function create({ fetchRoads, detect, onChange, extendRoads = roads => roads }) {
        let version = 0, pending = null, fetched = null;
        let state = { enabled: false, phase: 'off', blocks: null, roads: null, coverage: null, roadCount: 0, error: '' };
        const emit = patch => { state = { ...state, ...patch }; onChange(state); };
        function cancel() { version++; pending?.abort(); pending = null; }
        function setEnabled(enabled) {
            cancel();
            fetched = null;
            emit({ enabled, phase: enabled ? 'idle' : 'off', blocks: null, roads: null, coverage: null, error: '', roadCount: 0 });
        }
        async function refresh(viewport, force = false) {
            if (!state.enabled) return;
            const bbox = requestBounds(viewport);
            if (!bbox) {
                cancel();
                emit({ phase: 'zoom', blocks: null, roads: null, coverage: null, roadCount: 0 });
                return;
            }
            if (!force && state.phase === 'ready' && contains(state.coverage, viewport.bbox)) return;
            return loadBounds(bbox);
        }
        function start() {
            cancel();
            const ownVersion = version;
            const controller = new AbortController();
            pending = controller;
            return { controller, current: () => state.enabled && version === ownVersion };
        }
        async function loadBounds(bbox) {
            if (!state.enabled) return;
            fetched = null;
            const { controller, current } = start();
            emit({ phase: 'roads', blocks: null, roads: null, coverage: null, error: '', roadCount: 0 });
            try {
                const roads = await fetchRoads(bbox, controller.signal);
                if (!current()) return;
                if (roads.partial || roads.truncated) throw new Error('OSM road data is incomplete. Retry or zoom in.');
                fetched = { roads, bbox };
                await detectFetched(controller, current);
            } catch (error) {
                if (!current()) return;
                emit({ phase: 'error', blocks: null, roads: null, coverage: null, error: error.message });
            } finally {
                if (current()) pending = null;
            }
        }
        async function detectFetched(controller, current) {
            const roads = extendRoads(fetched.roads);
            emit({ phase: 'blocks', roadCount: roads.features.length });
            const blocks = await detect(roads, fetched.bbox, controller.signal);
            if (!current()) return;
            emit({ phase: 'ready', blocks, roads, coverage: fetched.bbox });
        }
        // While roads are still loading there is nothing to redo: that load extends them when it lands.
        async function redetect() {
            if (!state.enabled || !fetched || !['ready', 'blocks'].includes(state.phase)) return;
            const { controller, current } = start();
            try {
                await detectFetched(controller, current);
            } catch (error) {
                if (!current()) return;
                emit({ phase: 'error', blocks: null, roads: null, coverage: null, error: error.message });
            } finally {
                if (current()) pending = null;
            }
        }
        return { setEnabled, refresh, loadBounds, redetect, snapshot: () => state };
    }
    return { create, requestBounds };
});
