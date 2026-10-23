// Shared planning view state: display choices, the dice counter and the selection. Pure data
// logic, used by 2D, 3D and headless tests. Realising Permitted envelopes from the state lives
// in planning/envelopes.js.
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
        permittedForm: ['bound', 'configuration', 'both'],
        permittedMap: ['footprint', 'steps'], zoningAreas: ['off', 'ghost']
    });
    const defaults = Object.freeze({ existing: 'off', permitted: 'ghost', proposed: 'solid',
        existingScope: 'all', proposedForm: 'both', permittedForm: 'both', permittedMap: 'footprint', zoningAreas: 'off' });
    function settings(input = {}) {
        return Object.fromEntries(Object.entries(defaults).map(([key, value]) =>
            [key, choices[key].includes(input[key]) ? input[key] : value]));
    }
    function displayPolicy(state) { const values = settings(state); return Object.fromEntries(roles.map(role => [role, values[role]])); }
    function itemAppearance(item, state) {
        const values = settings(state);
        return item.assessment?.meaning === 'zoning-area' ? values.zoningAreas : values[item.role];
    }
    function createStore(initial = {}) {
        let state = Object.freeze({ ...settings(initial), proposedVariation: '', permittedVariation: '', selectedId: null, revision: 0 });
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
            // Each role has an independent roll. A layer showing only its envelope switches to
            // Both so the roll is visible.
            reroll: role => {
                if (role === 'proposed') return set({ proposedVariation: String(Number(state.proposedVariation) + 1),
                    proposedForm: state.proposedForm === 'massing' ? 'both' : state.proposedForm });
                if (role === 'permitted') return set({ permittedVariation: String(Number(state.permittedVariation) + 1),
                    permittedForm: state.permittedForm === 'bound' ? 'both' : state.permittedForm });
                return state;
            },
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
    function queryKey(city, bbox) { return `${city}:${bbox.map(value => Number(value).toFixed(5)).join(',')}`; }
    // The item that IS a parcel's permitted massing: its envelope when the source records one,
    // else the source's cached result for that parcel (`source.parcel`).
    function parcelItemOf(items, parcelId) {
        const id = parcelId == null ? '' : String(parcelId);
        if (!id) return null;
        const ofParcel = (Array.isArray(items) ? items : []).filter(item => item && item.role === 'permitted'
            && (String(item.sourceEvidence?.parcelReference?.parcelId ?? '') === id || String(item.source?.parcel ?? '') === id));
        return ofParcel.find(item => item.parcelEnvelope) || ofParcel[0] || null;
    }
    return { roles, displayStates, choices, defaults, settings, displayPolicy, itemAppearance, createStore, builtGeometry, queryKey, parcelItemOf };
});
