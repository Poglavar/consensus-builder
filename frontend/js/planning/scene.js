// Shared planning view state and geometry roles. Pure data logic, used by 2D, 3D and headless tests.
// A Permitted item may carry an outer bound plus configurations (the housing types or building
// forms it may be built as); the dice and the housing-type pin choose which one is shown inside.
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
    const defaults = Object.freeze({ existing: 'ghost', permitted: 'ghost', proposed: 'solid',
        existingScope: 'all', proposedForm: 'both', permittedForm: 'both', permittedMap: 'footprint', zoningAreas: 'off' });
    const ANY_CONFIGURATION = 'all';
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
            // One roll re-seeds every example build-out and every rolled configuration. A layer
            // showing only its envelope switches to Both so the roll is visible.
            reroll: () => set({ variation: String(Number(state.variation) + 1),
                proposedForm: state.proposedForm === 'massing' ? 'both' : state.proposedForm,
                permittedForm: state.permittedForm === 'bound' ? 'both' : state.permittedForm }),
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
    // FNV-1a: the same parcel lands on the same configuration in the map, the model and a shared link.
    function hash(text) {
        let h = 0x811c9dc5;
        for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
        return h >>> 0;
    }
    // Which configuration an item shows: a per-item pin wins, then a pinned housing type, then
    // a deterministic roll over the drawable configurations. Null means only the bound is shown.
    function configurationFor(item, { variation = '', scenario = ANY_CONFIGURATION, pins = {} } = {}) {
        const list = Array.isArray(item?.configurations) ? item.configurations : [];
        if (!list.length) return null;
        const pinned = pins[item.id] ? list.find(configuration => configuration.id === pins[item.id]) : null;
        if (pinned) return pinned;
        if (scenario && scenario !== ANY_CONFIGURATION) return list.find(configuration => configuration.id === scenario) || null;
        const drawable = list.filter(configuration => configuration.volumes?.length);
        if (!drawable.length) return null;
        return drawable[(hash(String(item.id)) + (Number(variation) || 0)) % drawable.length];
    }
    function volumeFeatures(item, geometryRole = 'body', configurationId = null) {
        if (item?.spatialReference?.horizontal !== 'OGC:CRS84' || item?.spatialReference?.unit !== 'm'
            || item?.spatialReference?.vertical !== 'relative-ground') return [];
        return (item.volumes || []).filter(volume => ['Polygon', 'MultiPolygon'].includes(volume.geometry?.type)
            && typeof volume.baseM === 'number' && Number.isFinite(volume.baseM)
            && typeof volume.topM === 'number' && Number.isFinite(volume.topM) && volume.topM > volume.baseM)
            .map(volume => ({ type: 'Feature', geometry: volume.geometry, properties: {
                representationId: item.id, sourceProposalId: item.proposalId, role: item.role, geometryRole, configurationId,
                partId: volume.id, baseM: volume.baseM, topM: volume.topM, height: volume.topM - volume.baseM
            } }));
    }
    // The volumes a Permitted item draws: `bound` is the translucent outer hull, `body` the shown
    // configuration. Items without configurations (one calculated option) draw their volumes as body.
    function permittedFeatures(item, state, selection) {
        if (!Array.isArray(item?.configurations) || !item.configurations.length) return { bound: [], body: volumeFeatures(item), configuration: null };
        const form = settings(state).permittedForm;
        const configuration = configurationFor(item, selection);
        const body = form === 'bound' || !configuration ? [] : volumeFeatures({ ...item, volumes: configuration.volumes }, 'body', configuration.id);
        const bound = form === 'configuration' && body.length ? [] : volumeFeatures(item, 'bound');
        return { bound, body, configuration };
    }
    // The joined ground projection has one boundary. Height-part boundaries are an explicit detail.
    function mapFeatures(item, detail, deps, state, selection) {
        if (item.areas?.length) return item.areas.map(area => ({ type: 'Feature', geometry: area.geometry,
            properties: { representationId: item.id, role: item.role, geometryRole: 'zoning-area' } }));
        const { bound, body } = permittedFeatures(item, state, selection);
        const join = features => {
            if (detail === 'steps' || features.length < 2) return features;
            const joined = features.reduce((result, feature) => result ? deps.union(result, feature) : feature, null);
            const baseM = Math.min(...features.map(feature => feature.properties.baseM));
            const topM = Math.max(...features.map(feature => feature.properties.topM));
            return joined?.geometry ? [{ ...joined, properties: { ...features[0].properties, partId: null, baseM, topM, height: topM - baseM } }] : [];
        };
        return [...join(bound), ...join(body)];
    }
    function queryKey(city, bbox) { return `${city}:${bbox.map(value => Number(value).toFixed(5)).join(',')}`; }
    return { roles, displayStates, choices, defaults, ANY_CONFIGURATION, settings, displayPolicy, itemAppearance, createStore, builtGeometry,
        configurationFor, volumeFeatures, permittedFeatures, mapFeatures, queryKey };
});
