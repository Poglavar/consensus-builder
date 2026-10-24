// Serializable interior display choices shared by URL links, named views and camera flights.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) {
        root.ThreeViewState = api;
        root.ThreeViewStateStore = api.createStore(api.read(root.location.search), state => {
            const url = new URL(root.location.href);
            for (const [key, value] of Object.entries(state)) url.searchParams.set(key, value);
            root.history.replaceState(root.history.state, '', url);
            root.dispatchEvent(new CustomEvent('threeinteriorviewchange', { detail: state }));
        });
    }
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const defaults = Object.freeze({ xray: '0', suggested: '0', suggestedExisting: '0', cutaway: 'all' });
    function valid(key, value) {
        return key === 'cutaway' ? value === 'all' || (typeof value === 'string' && /^-?\d+$/.test(value)
            && Number(value) >= -100 && Number(value) <= 100) : ['xray', 'suggested', 'suggestedExisting'].includes(key) && ['0', '1'].includes(value);
    }
    function normalize(input = {}) {
        return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, valid(key, input[key]) ? input[key] : fallback]));
    }
    function read(search) { return normalize(Object.fromEntries(new URLSearchParams(search || ''))); }
    function createStore(initial, onChange = () => {}) {
        let state = Object.freeze(normalize(initial));
        return {
            get: () => ({ ...state }),
            set(patch) {
                const next = normalize({ ...state, ...patch });
                if (Object.keys(defaults).some(key => next[key] !== state[key])) {
                    state = Object.freeze(next); onChange({ ...state });
                }
                return { ...state };
            }
        };
    }
    return Object.freeze({ defaults, valid, normalize, read, createStore });
});
