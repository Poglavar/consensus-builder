// Shared planning view state and geometry roles. Pure data logic, used by 2D, 3D and headless tests.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PlanningScene = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const roles = Object.freeze(['existing', 'permitted', 'proposed']);
    const displayStates = Object.freeze(['solid', 'ghost', 'off']);
    const choices = Object.freeze({
        existing: displayStates, permitted: displayStates, proposed: displayStates,
        existingScope: ['all', 'surviving', 'removed'],
        proposedForm: ['massing', 'buildout', 'both'],
        permittedMap: ['footprint', 'steps']
    });
    const defaults = Object.freeze({ existing: 'ghost', permitted: 'ghost', proposed: 'solid',
        existingScope: 'all', proposedForm: 'both', permittedMap: 'footprint' });
    function settings(input = {}) {
        return Object.fromEntries(Object.entries(defaults).map(([key, value]) =>
            [key, choices[key].includes(input[key]) ? input[key] : value]));
    }
    function displayPolicy(state) { const values = settings(state); return Object.fromEntries(roles.map(role => [role, values[role]])); }
    function createStore(initial = {}) {
        let state = Object.freeze({ ...settings(initial), variation: '', selectedId: null, revision: 0 });
        const listeners = new Set();
        const set = patch => {
            if (Object.keys(patch).every(key => state[key] === patch[key])) return state;
            state = Object.freeze({ ...state, ...patch, revision: state.revision + 1 });
            listeners.forEach(listener => listener(state));
            return state;
        };
        return {
            get: () => state,
            configure: (key, value) => choices[key]?.includes(value) ? set({ [key]: value }) : state,
            reroll: () => set({ variation: String(Number(state.variation) + 1),
                proposedForm: state.proposedForm === 'massing' ? 'both' : state.proposedForm }),
            select: id => set({ selectedId: id === null ? null : String(id) }),
            subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
        };
    }
    // Display selection only: never change the observed feature or demolition record.
    function builtGeometry(geometry, record, scope = 'all') {
        if (scope === 'all') return geometry;
        if (scope === 'surviving') return record ? (record.remainder || null) : geometry;
        if (scope === 'removed') return record ? (record.demolishedPart || record.geometry || geometry) : null;
        return geometry;
    }
    function volumeFeatures(item) {
        if (item?.spatialReference?.horizontal !== 'OGC:CRS84' || item?.spatialReference?.unit !== 'm'
            || item?.spatialReference?.vertical !== 'relative-ground') return [];
        return (item.volumes || []).filter(volume => ['Polygon', 'MultiPolygon'].includes(volume.geometry?.type)
            && typeof volume.baseM === 'number' && Number.isFinite(volume.baseM)
            && typeof volume.topM === 'number' && Number.isFinite(volume.topM) && volume.topM > volume.baseM)
            .map(volume => ({ type: 'Feature', geometry: volume.geometry, properties: {
                representationId: item.id, sourceProposalId: item.proposalId, role: item.role,
                partId: volume.id, baseM: volume.baseM, topM: volume.topM, height: volume.topM - volume.baseM
            } }));
    }
    // The joined ground projection has one boundary. Height-part boundaries are an explicit detail.
    function mapFeatures(item, detail, deps) {
        const features = volumeFeatures(item);
        if (detail === 'steps' || features.length < 2) return features;
        const joined = features.reduce((result, feature) => result ? deps.union(result, feature) : feature, null);
        return joined?.geometry ? [{ ...joined, properties: { representationId: item.id, role: item.role } }] : [];
    }
    function queryKey(city, bbox) { return `${city}:${bbox.map(value => Number(value).toFixed(5)).join(',')}`; }
    return { roles, displayStates, choices, defaults, settings, displayPolicy, createStore, builtGeometry, volumeFeatures, mapFeatures, queryKey };
});
