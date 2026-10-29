// What is still loading for each Buildings and massing role (built, permitted, proposed), by the
// code loading it. Loaded before the map, so the first fetches report too; planning/views.js
// draws it as the ring around the Buildings and massing button.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PlanningLoading = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
    'use strict';
    const sources = { existing: new Set(), permitted: new Set(), proposed: new Set() };
    // set('existing', 'map', true) while the map's buildings fetch runs; false when it ends.
    function set(role, source, on) {
        const holders = sources[role];
        if (!holders) throw new Error(`Unknown Buildings and massing role: ${role}`);
        if (holders.has(source) === !!on) return;
        if (on) holders.add(source); else holders.delete(source);
        root?.dispatchEvent(new CustomEvent('planningloadingchange', { detail: state() }));
    }
    function state() {
        return Object.fromEntries(Object.entries(sources).map(([role, holders]) => [role, holders.size > 0]));
    }
    return { set, state };
});
