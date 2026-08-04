// One answer to "may the map respond to this click?" — and one place for an editing mode to say
// "the map is mine until I am saved or cancelled".
//
// Without this, an editor docked over the live map is only half-modal: its panel is open, but every
// other layer still answers clicks. That is not just untidy, it silently breaks the editor itself —
// the park editor's own placement clicks were being swallowed by the park polygon underneath, which
// stopped the event to select its proposal, so the click never reached the editor and placing an
// item did nothing at all.
//
// Two questions, deliberately separate:
//   isHeld()          — an editor has CLAIMED the map (exclusive editing mode)
//   blocksSelection() — a click must not select/hover anything: the claim above, plus the
//                       pre-existing modes that already meant this (measuring, drawing, cadastre
//                       view, browse mode, area painting). Consumers used to keep private copies of
//                       that list, which is how they drifted apart.
(function attachMapEditLock(global) {
    'use strict';

    const state = { owner: null, label: '' };

    function syncBodyClass() {
        try {
            global.document?.body?.classList.toggle('map-edit-locked', !!state.owner);
        } catch (_) { }
    }

    // Claiming is idempotent for the same owner. A second, different owner is refused rather than
    // silently taking over: two editors on one map is the bug, not the fix.
    function claim(owner, label) {
        const id = String(owner || '').trim();
        if (!id) return false;
        if (state.owner && state.owner !== id) {
            console.warn('[mapEditLock] refused: the map is already held by', state.owner);
            return false;
        }
        state.owner = id;
        state.label = label || id;
        syncBodyClass();
        return true;
    }

    // Only the holder may release, so a stray teardown elsewhere cannot unlock a live editor.
    function release(owner) {
        const id = String(owner || '').trim();
        if (!state.owner) return false;
        if (id && state.owner !== id) return false;
        state.owner = null;
        state.label = '';
        syncBodyClass();
        return true;
    }

    function isHeld() { return !!state.owner; }
    function heldBy() { return state.owner; }
    function label() { return state.label; }

    function truthy(name) {
        try { return global[name] === true; } catch (_) { return false; }
    }

    function activeFn(name) {
        try { return typeof global[name] === 'function' && global[name]() === true; } catch (_) { return false; }
    }

    function blocksSelection() {
        if (isHeld()) return true;
        if (truthy('measureMode') || global.measureMode) return true;
        if (truthy('roadDrawingMode')) return true;
        if (truthy('cadastreViewActive')) return true;
        try { if (global.proposalListBrowseMode) return true; } catch (_) { }
        if (activeFn('isParcelDrawingModeActive')) return true;
        if (activeFn('isStructureGeometryEditorActive')) return true;
        try { if (global.AreaMonitorPaint && global.AreaMonitorPaint.isActive()) return true; } catch (_) { }
        return false;
    }

    const api = { claim, release, isHeld, heldBy, label, blocksSelection };
    if (typeof window !== 'undefined') window.__mapEditLock = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
