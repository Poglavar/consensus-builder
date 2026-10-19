// While a shared-plan link waits for the boot replay, the map stays usable: progress goes to the
// status line (not a modal), and a user who takes over the map meanwhile is not pulled away by the
// link's own framing and panel opening afterwards (sharing-routes.js handleSharedPlanRoute).
(function attachReplayStatus(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ReplayStatus = api;
})(typeof window !== 'undefined' ? window : globalThis, function replayStatusFactory() {
    'use strict';

    // One status line per replay progress event: members counted while they replay, a plain
    // "rebuilding" line for the phases before them (ground, reset, corridors, commit).
    function replayStatusText(event, tShare) {
        if (!event || typeof event !== 'object') return null;
        const done = Number(event.done);
        const total = Number(event.total);
        if (event.phase === 'proposal-apply' && Number.isFinite(done) && Number.isFinite(total) && total > 0) {
            return tShare('plan.rebuildingStatusCount', 'Rebuilding the applied plan {{done}}/{{total}}…', { done, total });
        }
        return tShare('plan.rebuildingStatus', 'Rebuilding the applied plan…');
    }

    // An onProgress listener that reports each distinct line once.
    function statusReporter(tShare, report) {
        let last = null;
        return event => {
            const text = replayStatusText(event, tShare);
            if (!text || text === last) return;
            last = text;
            report(text);
        };
    }

    // Any real input (a pan, a zoom, a click, a key) while the link waits means the user has taken
    // over the map. Synthetic events (isTrusted false) do not count.
    const TAKEOVER_EVENTS = Object.freeze(['pointerdown', 'wheel', 'keydown', 'touchstart']);

    function watchUserTakeover(target) {
        let tookOver = false;
        const onInput = event => {
            if (event && event.isTrusted !== false) tookOver = true;
        };
        TAKEOVER_EVENTS.forEach(type => target.addEventListener(type, onInput, { capture: true, passive: true }));
        return {
            tookOver: () => tookOver,
            stop() {
                TAKEOVER_EVENTS.forEach(type => target.removeEventListener(type, onInput, { capture: true }));
            }
        };
    }

    return Object.freeze({ replayStatusText, statusReporter, watchUserTakeover, TAKEOVER_EVENTS });
});
