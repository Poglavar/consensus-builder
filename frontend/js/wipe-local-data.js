(function (global) {
    'use strict';

    // Provide a minimal, dependency-free wipeLocalData early in the load order.
    if (typeof global.wipeLocalData === 'function') {
        return;
    }

    global.wipeLocalData = function wipeLocalData(options = {}) {
        const { skipReload = false } = options || {};
        try {
            if (global.PersistentStorage && typeof global.PersistentStorage.clear === 'function') {
                global.PersistentStorage.clear();
                // Ensure we also clear again after the initial IndexedDB load finishes, to avoid re-population.
                if (global.PersistentStorage.ready && typeof global.PersistentStorage.ready.then === 'function') {
                    global.PersistentStorage.ready.then(() => {
                        try { global.PersistentStorage.clear(); } catch (_) { /* ignore */ }
                    });
                }
            }
        } catch (_) { /* ignore */ }

        try {
            if (global.localStorage && typeof global.localStorage.clear === 'function') {
                global.localStorage.clear();
            }
        } catch (_) { /* ignore */ }

        try {
            if (global.sessionStorage && typeof global.sessionStorage.clear === 'function') {
                global.sessionStorage.clear();
            }
        } catch (_) { /* ignore */ }

        if (!skipReload) {
            try { global.location && global.location.reload && global.location.reload(); } catch (_) { /* ignore */ }
        }
    };
})(typeof window !== 'undefined' ? window : globalThis);

