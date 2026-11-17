// Which existing buildings' floor models X-ray should load or drop, given the camera, and which
// buildings' floor-plan groups the scene should add or remove. Pure: no DOM,
// no Three.js, no network. Floor plans are never bulk-loaded: only marked buildings near the viewer
// while X-ray is on, nearest first, a few at a time; a building is dropped only once it is well
// beyond the load radius (hysteresis), so orbiting at the edge does not reload it.
(function (global) {
    'use strict';
    // 200 m from the camera (3D distance, so a high overview loads nothing): a street-level or close
    // orbit view covers a building and its neighbours across the street. A 100 m slab's model is
    // ~300 KB, so a handful at a time.
    const DEFAULTS = Object.freeze({ loadRadiusM: 200, unloadRadiusM: 300, maxConcurrent: 2, maxResident: 24 });

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
        const wanted = new Set([...byKey.values()]
            .map(candidate => ({ key: candidate.key, distance: distance(candidate) }))
            .filter(item => item.distance <= (state.loaded.has(item.key) || state.pending.has(item.key) ? options.unloadRadiusM : options.loadRadiusM))
            .sort((a,b) => a.distance - b.distance || String(a.key).localeCompare(String(b.key)))
            .slice(0, options.maxResident).map(item => item.key));
        const beyond = key => !wanted.has(key);
        const unload = loaded.filter(beyond);
        const cancel = pending.filter(beyond);
        const slots = Math.max(0, options.maxConcurrent - (pending.length - cancel.length));
        const load = [...byKey.values()]
            .filter(candidate => wanted.has(candidate.key) && !state.loaded.has(candidate.key) && !state.pending.has(candidate.key))
            .map(candidate => ({ key: candidate.key, distance: distance(candidate) }))
            .filter(entry => entry.distance <= options.loadRadiusM)
            .sort((a, b) => a.distance - b.distance || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
            .slice(0, slots).map(entry => entry.key);
        return { load, cancel, unload };
    }

    /**
     * Which buildings' floor-plan groups the scene should add or remove, building by building: one
     * per building with a loaded model whose untouched shell is in the scene, none while X-ray is off.
     * Nothing else in the scene is involved.
     * @param state { enabled, models: Map(key → model|null), shells: Map|Set keys of shells in the
     *   scene, shown: Map(key → group) }
     * @returns { add: keys, remove: keys }
     */
    function reconcileFloorPlanGroups({ enabled, models, shells, shown }) {
        const remove = [...shown.keys()].filter(key => !enabled || !models.get(key) || !shells.has(key));
        const add = enabled ? [...models.keys()].filter(key => models.get(key) && shells.has(key) && !shown.has(key)) : [];
        return { add, remove };
    }

    const DETAIL_DEFAULTS = Object.freeze({ radiusM: 200, maxBuildings: 24, maxStoreys: 96, maxStoreysPerBuilding: 8, maxTriangles: 1000000 });
    function visibleFloorDetails(candidates, options = {}) {
        const { radiusM, maxBuildings } = { ...DETAIL_DEFAULTS, ...options };
        return new Set(candidates.filter(item => item.visible && Number.isFinite(item.distanceM) && item.distanceM <= radiusM)
            .sort((a,b) => a.distanceM - b.distanceM || String(a.key).localeCompare(String(b.key)))
            .slice(0, maxBuildings).map(item => item.key));
    }
    function visibleStoreyDetails(candidates, options = {}) {
        const { radiusM, maxStoreys, maxStoreysPerBuilding, maxTriangles } = { ...DETAIL_DEFAULTS, ...options };
        const byBuilding = new Map();
        let count = 0, triangles = 0;
        for (const item of candidates.filter(item => item.visible && Number.isFinite(item.distanceM) && item.distanceM <= radiusM)
            .sort((a,b) => a.distanceM - b.distanceM || a.level - b.level)) {
            if (count >= maxStoreys) break;
            const levels = byBuilding.get(item.key) || new Set();
            if (levels.size >= maxStoreysPerBuilding || triangles + (item.triangles || 0) > maxTriangles) continue;
            triangles += item.triangles || 0;
            levels.add(item.level); byBuilding.set(item.key, levels); count++;
        }
        return byBuilding;
    }
    const api = { DEFAULTS, DETAIL_DEFAULTS, visibleFloorDetails, visibleStoreyDetails, planFloorPlanLoads, reconcileFloorPlanGroups };
    global.__floorPlanProximity = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
