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

        // Delete the entire IndexedDB database to ensure complete removal
        try {
            if (global.indexedDB && typeof global.indexedDB.deleteDatabase === 'function') {
                global.indexedDB.deleteDatabase('consensus-builder-storage');
            }
        } catch (_) { /* ignore */ }

        // Clear Cache Storage API (if used by service workers or cache API)
        try {
            if (global.caches && typeof global.caches.keys === 'function') {
                global.caches.keys().then(function (names) {
                    names.forEach(function (name) {
                        try { global.caches.delete(name); } catch (_) { /* ignore */ }
                    });
                }).catch(function () { /* ignore */ });
            }
        } catch (_) { /* ignore */ }

        if (!skipReload) {
            try { global.location && global.location.reload && global.location.reload(); } catch (_) { /* ignore */ }
        }
    };
})(typeof window !== 'undefined' ? window : globalThis);

