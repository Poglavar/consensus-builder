// Tells a design dialog (Block, Freeform building) whether the user changed its design, so
// closing an untouched dialog does not ask "Discard this design?". Pure apart from the injected
// event target: the baseline is the design signature captured just before the first user input.
(function (global) {
    'use strict';

    // Capture-phase events that precede every user change, in the dialog or on the map.
    const INPUT_EVENTS = ['pointerdown', 'keydown', 'input', 'change', 'wheel'];

    function createDesignChangeTracker(options) {
        const signature = options && options.signature;
        if (typeof signature !== 'function') throw new Error('createDesignChangeTracker needs a signature() function');
        let target = null;
        let baseline = null;
        let hasBaseline = false;

        function capture() {
            if (hasBaseline) return;
            baseline = signature();
            hasBaseline = true;
        }

        function stop() {
            if (target) INPUT_EVENTS.forEach(type => target.removeEventListener(type, capture, true));
            target = null;
        }

        // Call when the dialog opens. The auto-generated first design is not a user change.
        function start(eventTarget) {
            stop();
            baseline = null;
            hasBaseline = false;
            target = eventTarget || null;
            if (target) INPUT_EVENTS.forEach(type => target.addEventListener(type, capture, true));
        }

        // No user input since start() means nothing can have changed.
        function changed() {
            if (!hasBaseline) return false;
            return signature() !== baseline;
        }

        return { start, stop, changed, capture };
    }

    // Stable string for a list of GeoJSON-ish features (geometry + properties).
    function featuresSignature(features) {
        const list = (Array.isArray(features) ? features : [features]).filter(Boolean);
        return JSON.stringify(list.map(f => [f.geometry || null, f.properties || null]));
    }

    const api = { createDesignChangeTracker, featuresSignature };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.DesignChangeTracker = api;
})(typeof window !== 'undefined' ? window : globalThis);
