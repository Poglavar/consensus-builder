// Shared planning view state and geometry roles. Pure data logic, used by 2D, 3D and headless tests.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PlanningScene = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const modes = Object.freeze(['existing', 'permitted', 'proposed', 'compare']);
    const policies = Object.freeze({
        existing: { existing: 'solid', permitted: 'off', proposed: 'off' },
        permitted: { existing: 'ghost', permitted: 'solid', proposed: 'off' },
        proposed: { existing: 'ghost', permitted: 'off', proposed: 'solid' },
        compare: { existing: 'ghost', permitted: 'ghost', proposed: 'solid' }
    });
    function displayPolicy(mode) { return { ...(policies[mode] || policies.compare) }; }
    function createStore(initial = {}) {
        let state = Object.freeze({ mode: modes.includes(initial.mode) ? initial.mode : 'compare', selectedId: null, revision: 0 });
        const listeners = new Set();
        const set = patch => {
            if (Object.keys(patch).every(key => state[key] === patch[key])) return state;
            state = Object.freeze({ ...state, ...patch, revision: state.revision + 1 });
            listeners.forEach(listener => listener(state));
            return state;
        };
        return {
            get: () => state,
            setMode: mode => modes.includes(mode) ? set({ mode }) : state,
            select: id => set({ selectedId: id === null ? null : String(id) }),
            subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
        };
    }
    function volumeFeatures(item) {
        if (item?.spatialReference?.horizontal !== 'OGC:CRS84' || item?.spatialReference?.unit !== 'm'
            || item?.spatialReference?.vertical !== 'relative-ground') return [];
        return (item.volumes || []).filter(volume => ['Polygon', 'MultiPolygon'].includes(volume.geometry?.type)
            && typeof volume.baseM === 'number' && Number.isFinite(volume.baseM)
            && typeof volume.topM === 'number' && Number.isFinite(volume.topM) && volume.topM > volume.baseM)
            .map(volume => ({ type: 'Feature', geometry: volume.geometry, properties: {
                representationId: item.id, sourceProposalId: item.proposalId, role: item.role,
                partId: volume.id, baseM: volume.baseM, height: volume.topM - volume.baseM
            } }));
    }
    function queryKey(city, bbox) { return `${city}:${bbox.map(value => Number(value).toFixed(5)).join(',')}`; }
    return { modes, displayPolicy, createStore, volumeFeatures, queryKey };
});
