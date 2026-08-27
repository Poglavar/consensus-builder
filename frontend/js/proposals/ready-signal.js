/* A settle-once promise handle: a producer says "ready" whenever it gets there, a consumer
   awaits it, and saying it twice is harmless.

   It exists because the share-plan flow now KEEPS A DIALOG OPEN until the panel behind it is
   worth revealing. That inverts the failure mode: before, the dialog closed too early and the
   user watched an empty map fill in; now, a path that forgets to signal leaves the user staring
   at a spinner forever. So the signal has to be safe to fire from several places at once — the
   happy path, a `finally` backstop, an error handler — and fire only the first time. */

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    // Namespaced, not a bare global: a top-level name in a classic script is a global, and the
    // last file loaded would win for every caller in every file.
    else root.__readySignal = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function createReadySignal() {
        let resolveOnce = null;
        let settled = false;
        let outcome;
        const promise = new Promise((resolve) => { resolveOnce = resolve; });
        return {
            promise,
            get settled() { return settled; },
            get outcome() { return outcome; },
            // Returns whether THIS call was the one that settled it, so a caller can tell a
            // real completion from a backstop that arrived after the fact.
            settle(value) {
                if (settled) return false;
                settled = true;
                outcome = value;
                if (resolveOnce) resolveOnce(value);
                return true;
            }
        };
    }

    return { createReadySignal };
}));
