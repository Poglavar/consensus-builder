(function (global) {
    'use strict';

    // The one function that actually erases local data. Dependency-free and defined early, so any
    // caller can rely on it. Deliberately NOT named `wipeLocalData`: sidebar-management.js declares
    // a global function of that name, which used to shadow this one after load — leaving the sidebar
    // button and the city switch quietly clearing less (no localStorage, no IndexedDB drop) than the
    // boot path did. That wrapper now delegates here, so there is exactly one eraser.
    global.wipeAllLocalData = async function wipeAllLocalData(options = {}) {
        const { skipReload = false } = options || {};

        // Synchronous in-memory clears first so anything reading from cache
        // immediately after the call sees an empty store.
        try { global.PersistentStorage && global.PersistentStorage.clear && global.PersistentStorage.clear(); } catch (_) { /* ignore */ }
        try { global.localStorage && global.localStorage.clear && global.localStorage.clear(); } catch (_) { /* ignore */ }
        try { global.sessionStorage && global.sessionStorage.clear && global.sessionStorage.clear(); } catch (_) { /* ignore */ }

        // Async cleanup: we must actually wait for these before reloading,
        // otherwise IndexedDB / Cache Storage can survive into the next session
        // and an agent in city B can find leftover parcels/proposals from city A.
        const tasks = [];

        if (global.PersistentStorage && global.PersistentStorage.ready && typeof global.PersistentStorage.ready.then === 'function') {
            tasks.push(global.PersistentStorage.ready.then(() => {
                try { global.PersistentStorage.clear(); } catch (_) { /* ignore */ }
            }).catch(() => { /* ignore */ }));
        }

        if (global.indexedDB && typeof global.indexedDB.deleteDatabase === 'function') {
            tasks.push(new Promise(resolve => {
                try {
                    const req = global.indexedDB.deleteDatabase('consensus-builder-storage');
                    req.onsuccess = () => resolve();
                    req.onerror = () => resolve();
                    req.onblocked = () => resolve();
                } catch (_) { resolve(); }
            }));
        }

        if (global.caches && typeof global.caches.keys === 'function') {
            tasks.push(global.caches.keys()
                .then(names => Promise.all(names.map(name => global.caches.delete(name).catch(() => { /* ignore */ }))))
                .catch(() => { /* ignore */ }));
        }

        await Promise.allSettled(tasks);

        if (!skipReload) {
            try { global.location && global.location.reload && global.location.reload(); } catch (_) { /* ignore */ }
        }
    };
})(typeof window !== 'undefined' ? window : globalThis);

