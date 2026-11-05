// Which existing buildings' floor models X-ray should load or drop, given the camera. Pure: no DOM,
// no Three.js, no network. Floor plans are never bulk-loaded: only marked buildings near the viewer
// while X-ray is on, nearest first, a few at a time; a building is dropped only once it is well
// beyond the load radius (hysteresis), so orbiting at the edge does not reload it.
(function (global) {
    'use strict';
    // 200 m from the camera (3D distance, so a high overview loads nothing): a street-level or close
    // orbit view covers a building and its neighbours across the street. A 100 m slab's model is
    // ~300 KB, so a handful at a time.
    const DEFAULTS = Object.freeze({ loadRadiusM: 200, unloadRadiusM: 300, maxConcurrent: 2 });

    /**
     * @param state {
     *   enabled: boolean (X-ray on),
     *   camera: [x, y, z] metres in the scene's local frame (z = height above ground),
     *   candidates: [{ key, x, y }] marked buildings, ground centres in the same frame,
     *   loaded: Set|Map keys with an answer (a model or none), pending: Set|Map keys being requested,
     *   loadRadiusM, unloadRadiusM, maxConcurrent }
     * @returns { load: keys to request now, nearest first; cancel: pending keys to abandon;
     *            unload: loaded keys to drop }
     */
    function planFloorPlanLoads(state) {
        const options = { ...DEFAULTS, ...state };
        const loaded = [...(state.loaded?.keys?.() || [])], pending = [...(state.pending?.keys?.() || [])];
        if (!state.enabled || !Array.isArray(state.camera)) return { load: [], cancel: pending, unload: loaded };
        const [cx, cy, cz] = state.camera;
        const byKey = new Map((state.candidates || []).map(candidate => [candidate.key, candidate]));
        const distance = candidate => Math.hypot(candidate.x - cx, candidate.y - cy, cz || 0);
        const beyond = key => { const candidate = byKey.get(key); return !candidate || !(distance(candidate) <= options.unloadRadiusM); };
        const unload = loaded.filter(beyond);
        const cancel = pending.filter(beyond);
        const slots = Math.max(0, options.maxConcurrent - (pending.length - cancel.length));
        const load = [...byKey.values()]
            .filter(candidate => !state.loaded.has(candidate.key) && !state.pending.has(candidate.key))
            .map(candidate => ({ key: candidate.key, distance: distance(candidate) }))
            .filter(entry => entry.distance <= options.loadRadiusM)
            .sort((a, b) => a.distance - b.distance || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
            .slice(0, slots).map(entry => entry.key);
        return { load, cancel, unload };
    }

    const api = { DEFAULTS, planFloorPlanLoads };
    global.__floorPlanProximity = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
