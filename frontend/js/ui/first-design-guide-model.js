// Which getting-started hint a newcomer sees, decided from plain facts about the page. The hints
// follow what the person has done (opened the map, picked a parcel, saved a design); none blocks.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.FirstDesignGuideModel = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    // Set once the guide has finished or been closed. The browser tests seed it for every
    // returning-visitor scenario, so only a first visit shows the hints.
    const SEEN_KEY = 'cb_site_intro_seen_v1';

    // Page states (body classes) that own the screen: the globe, an editor or drawing tool with
    // its own hint line, a dialog or sheet, a place without parcels (it has its own banner).
    const QUIET = [
        'world-view-open', 'world-view-pending', 'workspace-unavailable', 'explore-city',
        'proposal-editor-open', 'on-map-editing', 'site-tool-active', 'site-tool-drawing', 'site-proposing',
        'corridor-editor-open', 'corridor-drawing-active', 'agreement-editor-open', 'agreement-panel-open',
        'area-monitor-drawing-active', 'area-monitor-creation-active', 'parcel-estimate-open',
        'ground-fallback-open', 'site-intro-open', 'command-palette-open', 'map-sheet-open'
    ];
    const SCENE = ['three-mode-active', 'realistic-mode-active'];
    const GROUND_KINDS = ['parcels', 'formed'];

    // facts: { seen, created, classes: string[], selectedKind: string|null }
    // Returns 'open-map' | 'click-parcel' | 'pick-tool' | 'saved' | null.
    function step(facts) {
        const classes = Array.isArray(facts && facts.classes) ? facts.classes : [];
        const has = name => classes.includes(name);
        if (!facts || QUIET.some(has)) return null;
        // The first design of this visit is announced even though the flag is already stored.
        if (facts.created) return 'saved';
        if (facts.seen) return null;
        if (SCENE.some(has)) return 'open-map';
        if (has('click-stack-open') && GROUND_KINDS.includes(facts.selectedKind)) return 'pick-tool';
        return 'click-parcel';
    }

    // The buttons each hint offers, in order; the first is the primary one.
    function actions(name) {
        if (name === 'open-map') return ['open-map', 'how-it-works'];
        if (name === 'click-parcel') return ['how-it-works'];
        if (name === 'saved') return ['see-3d'];
        return [];
    }

    return { SEEN_KEY, QUIET, step, actions };
});
