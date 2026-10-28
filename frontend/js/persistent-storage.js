// Per-workspace, per-city key/value storage on IndexedDB.
//
// One durable workspace per browser profile, with separate geographic-context databases.
// A Web Lock allows only its editing tab to load or write these stores.
//
// Which database to open is decided by PersistentStorage.setScope(cityId), called by city-config as
// soon as it resolves the current city — before anything reads. Callers that never set a scope (the
// standalone pages) fall back to the legacy, unscoped database.
(function () {
    const globalScope = typeof window !== 'undefined' ? window : self;
    const hasIndexedDB = typeof globalScope.indexedDB !== 'undefined';

    const DB_NAME_PREFIX = 'consensus-builder-storage';
    // Standalone pages without workspace bootstrap retain their unscoped store.
    const LEGACY_DB_NAME = DB_NAME_PREFIX;
    const WORKSPACE_INITIALIZED_KEY = '__workspace_initialized';
    const workspace = globalScope.BrowserWorkspace;
    let scopeBinding = false;
    const DB_VERSION = 1;
    const STORE_NAME = 'kv';

    const cache = new Map();
    let dbInstance = null;
    let dbOpenPromise = null;
    let dbName = null;           // resolved by setScope(), or lazily to the legacy name
    let loadStarted = false;
    let readyResolve, readyReject;
    const ready = new Promise((resolve, reject) => {
        readyResolve = resolve; readyReject = reject;
    });
    ready.catch(() => {});

    // Owner rows of derived live pieces (parcel_<piece id with #>_owner) are rebuilt by every replay
    // of the applied plan, so they live in this cache only: the browser stores no part of the built
    // map. Durable rows of that shape written before this rule are not loaded; their keys are kept
    // here and deleted from IndexedDB with the next write.
    function isDerivedParcelId(id) {
        return String(id == null ? '' : id).includes('#');
    }
    function isMemoryOnlyKey(key) {
        const text = String(key == null ? '' : key);
        return text.startsWith('parcel_') && text.endsWith('_owner') && isDerivedParcelId(text.slice(7, -6));
    }
    const storedMemoryOnlyKeys = new Set();
    function takeStoredMemoryOnlyKeys() {
        const keys = Array.from(storedMemoryOnlyKeys);
        storedMemoryOnlyKeys.clear();
        return keys;
    }

    // Writes issued before a city is bound. They must not be guessed into the legacy database:
    // that store belongs to the pre-upgrade world, and a stray write there would go to a city the
    // user is not in. Held here and flushed once the scope is known.
    const pendingWrites = [];

    function resolveDbName() {
        if (dbName) return dbName;
        dbName = LEGACY_DB_NAME; // no scope was ever set (a page without city-config)
        announceDatabase();
        return dbName;
    }

    // Expose the resolved name for diagnostics; each tab's workspace has its own database.
    function announceDatabase() {
        try {
            globalScope.dispatchEvent(new CustomEvent('persistentstoragedatabase', { detail: { name: dbName } }));
        } catch (_) { /* no event support */ }
    }

    function flushPendingWrites() {
        while (pendingWrites.length) {
            const write = pendingWrites.shift();
            if (write.type === 'put') persistPair(write.key, write.value);
            else if (write.type === 'delete') removePair(write.key);
            else if (write.type === 'clear') clearStore();
        }
    }

    function openDb() {
        if (!hasIndexedDB) {
            return Promise.reject(new Error('IndexedDB unavailable'));
        }
        if (dbInstance) {
            return Promise.resolve(dbInstance);
        }
        // IndexedDB open requests are stateful and relatively expensive. More importantly, two
        // callers opening the same database during boot can observe different upgrade/error
        // events. Keep exactly one in-flight request and make every caller share its outcome.
        if (dbOpenPromise) return dbOpenPromise;
        dbOpenPromise = new Promise((resolve, reject) => {
            let settled = false;
            const fail = error => {
                if (settled) return;
                settled = true;
                dbOpenPromise = null;
                reject(error);
            };
            const request = globalScope.indexedDB.open(resolveDbName(), DB_VERSION);
            request.onupgradeneeded = event => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'key' });
                }
            };
            request.onsuccess = () => {
                if (settled) {
                    try { request.result.close(); } catch (_) { }
                    return;
                }
                settled = true;
                dbInstance = request.result;
                dbInstance.onversionchange = () => {
                    try { dbInstance.close(); } catch (_) { }
                    dbInstance = null;
                    dbOpenPromise = null;
                };
                dbOpenPromise = null;
                resolve(dbInstance);
            };
            request.onerror = () => {
                fail(request.error || new Error('IndexedDB open failed'));
            };
            request.onblocked = () => {
                const error = new Error('IndexedDB open was blocked by another connection');
                error.code = 'indexeddb-open-blocked';
                fail(error);
            };
        });
        return dbOpenPromise;
    }

    function assertWorkspaceWritable() {
        if (!workspace || workspace.status === 'loading' || workspace.status === 'ready') return;
        const error = new Error('This tab no longer owns the saved workspace.');
        error.code = 'workspace-' + workspace.status;
        throw error;
    }

    function normalizedAtomicPuts(puts) {
        if (puts instanceof Map) return Array.from(puts.entries());
        if (Array.isArray(puts)) return puts.map(entry => Array.isArray(entry)
            ? entry
            : [entry && entry.key, entry && entry.value]);
        if (!puts || typeof puts !== 'object') return [];
        return Object.entries(puts);
    }

    // The authoritative mutation path uses this API exclusively. Cache publication happens only
    // after the IndexedDB transaction completes, so synchronous readers never observe a value that
    // failed to reach durable storage. Preference writes may continue to use setItem/removeItem.
    async function atomicWrite(change = {}) {
        const allPuts = normalizedAtomicPuts(change.puts).map(([key, value]) => [
            key != null ? String(key) : '',
            value != null ? String(value) : ''
        ]);
        const allDeletes = Array.from(change.deletes || [], key => key != null ? String(key) : '');
        const invalidKey = allPuts.some(([key]) => !key) || allDeletes.some(key => !key);
        if (invalidKey) throw new TypeError('PersistentStorage.atomicWrite requires non-empty string keys.');
        if (!allPuts.length && !allDeletes.length) return;
        const puts = allPuts.filter(([key]) => !isMemoryOnlyKey(key));
        const memoryPuts = allPuts.filter(([key]) => isMemoryOnlyKey(key));
        const memoryDeletes = allDeletes.filter(isMemoryOnlyKey);

        // Mutations are not allowed to guess a city before city-config binds the store. Await the
        // same readiness barrier used by all proposal boot code.
        await ready;
        assertWorkspaceWritable();

        const leftovers = takeStoredMemoryOnlyKeys();
        const deletes = allDeletes.filter(key => !isMemoryOnlyKey(key)).concat(leftovers);
        const publish = () => {
            deletes.forEach(key => cache.delete(key));
            memoryDeletes.forEach(key => cache.delete(key));
            puts.forEach(([key, value]) => cache.set(key, value));
            memoryPuts.forEach(([key, value]) => cache.set(key, value));
        };
        if (!hasIndexedDB || (!puts.length && !deletes.length)) {
            publish();
            return;
        }

        // A failed write leaves the leftover derived-owner rows for the next one.
        const restoreLeftovers = () => leftovers.forEach(key => storedMemoryOnlyKeys.add(key));
        let db;
        try { db = await openDb(); assertWorkspaceWritable(); } catch (error) { restoreLeftovers(); throw error; }
        await new Promise((resolve, reject) => {
            let transaction;
            let failure = null;
            let settled = false;
            const fail = error => {
                if (settled) return;
                settled = true;
                restoreLeftovers();
                reject(error || failure || new Error('IndexedDB atomic write failed'));
            };
            try {
                transaction = db.transaction(STORE_NAME, 'readwrite');
                const store = transaction.objectStore(STORE_NAME);
                const watch = request => {
                    request.onerror = () => {
                        failure = request.error || new Error('IndexedDB atomic write request failed');
                        try { transaction.abort(); } catch (_) { fail(failure); }
                    };
                };
                deletes.forEach(key => watch(store.delete(key)));
                puts.forEach(([key, value]) => watch(store.put({ key, value })));
                transaction.oncomplete = () => {
                    if (settled) return;
                    settled = true;
                    publish();
                    resolve();
                };
                transaction.onerror = () => {
                    failure = transaction.error || failure || new Error('IndexedDB atomic write transaction failed');
                };
                transaction.onabort = () => fail(
                    transaction.error || failure || new Error('IndexedDB atomic write transaction aborted')
                );
            } catch (error) {
                fail(error);
            }
        });
    }

    // Read a complete committed snapshot. A failed read must never become an empty workspace.
    function readAllFrom(name) {
        if (!hasIndexedDB) return Promise.resolve({});
        return new Promise((resolve, reject) => {
            const request = globalScope.indexedDB.open(name, DB_VERSION);
            let failed = false;
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains(STORE_NAME)) {
                    request.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
                }
            };
            request.onerror = () => { failed = true; reject(request.error || new Error('Workspace snapshot open failed')); };
            request.onblocked = () => { failed = true; reject(new Error('Workspace snapshot is blocked')); };
            request.onsuccess = () => {
                const db = request.result;
                if (failed) { db.close(); return; }
                try {
                    const out = {};
                    const tx = db.transaction(STORE_NAME, 'readonly');
                    const cursorRequest = tx.objectStore(STORE_NAME).openCursor();
                    cursorRequest.onsuccess = event => {
                        const cursor = event.target.result;
                        if (!cursor) return;
                        const record = cursor.value;
                        if (record && typeof record.key === 'string') {
                            out[record.key] = typeof record.value === 'string' ? record.value : JSON.stringify(record.value);
                        }
                        cursor.continue();
                    };
                    tx.oncomplete = () => { db.close(); resolve(out); };
                    tx.onabort = tx.onerror = () => { db.close(); reject(tx.error || new Error('Workspace snapshot read failed')); };
                } catch (error) { db.close(); reject(error); }
            };
        });
    }

    function writeSnapshot(name, entries) {
        return new Promise((resolve, reject) => {
            const request = globalScope.indexedDB.open(name, DB_VERSION);
            let failed = false;
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
            };
            request.onerror = () => { failed = true; reject(request.error || new Error('Workspace copy open failed')); };
            request.onblocked = () => { failed = true; reject(new Error('Workspace copy is blocked')); };
            request.onsuccess = () => {
                const db = request.result;
                if (failed) { db.close(); return; }
                try {
                    const tx = db.transaction(STORE_NAME, 'readwrite');
                    const store = tx.objectStore(STORE_NAME);
                    for (const [key, value] of Object.entries(entries)) {
                        if (!isMemoryOnlyKey(key)) store.put({ key, value });
                    }
                    store.put({ key: WORKSPACE_INITIALIZED_KEY, value: '1' });
                    tx.oncomplete = () => { db.close(); resolve(); };
                    tx.onabort = tx.onerror = () => { db.close(); reject(tx.error || new Error('Workspace snapshot copy failed')); };
                } catch (error) { db.close(); reject(error); }
            };
        });
    }

    async function initializeWorkspace(scope) {
        if (!hasIndexedDB) return;
        const manifest = workspace.databaseName('__workspace');
        if ((await readAllFrom(manifest))[WORKSPACE_INITIALIZED_KEY]) return;
        const cities = new Set([scope]);
        // Initialize the saved workspace from existing per-city data once. No tab creates a copy.
        const token = '__scope';
        const prefixes = workspace.sourceDatabaseNames(token).map(name => name.slice(0, -token.length));
        if (typeof globalScope.indexedDB.databases === 'function') {
            for (const { name } of await globalScope.indexedDB.databases()) {
                for (const prefix of prefixes) {
                    if (!name?.startsWith(prefix)) continue;
                    const city = name.slice(prefix.length);
                    if (city && !city.includes('::') && city !== '__workspace') cities.add(city);
                }
            }
        } else {
            for (const city of globalScope.CityConfigManager?.getAvailableCities?.() || []) cities.add(city.id);
        }
        for (const city of cities) {
            const target = workspace.databaseName(city);
            // Marker and copied records commit together; failed copies retry on reload.
            if ((await readAllFrom(target))[WORKSPACE_INITIALIZED_KEY]) continue;
            let snapshot = {};
            for (const name of workspace.sourceDatabaseNames(city)) {
                snapshot = await readAllFrom(name);
                if (Object.keys(snapshot).length) break;
            }
            await writeSnapshot(target, snapshot);
        }
        await writeSnapshot(manifest, {});
    }

    function loadCache() {
        if (loadStarted) return;
        loadStarted = true;
        if (!hasIndexedDB) {
            readyResolve();
            return;
        }
        openDb().then(db => {
            const transaction = db.transaction(STORE_NAME, 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.openCursor();
            request.onsuccess = event => {
                const cursor = event.target.result;
                if (cursor) {
                    const record = cursor.value;
                    // Never clobber a value already in the cache: it was written before the scope
                    // was bound and is newer than what the database holds.
                    if (record && record.key === WORKSPACE_INITIALIZED_KEY) {
                        // Private initialization marker, never application state.
                    } else if (record && typeof record.key === 'string' && isMemoryOnlyKey(record.key)) {
                        storedMemoryOnlyKeys.add(record.key);
                    } else if (record && typeof record.key === 'string' && !cache.has(record.key)) {
                        cache.set(record.key, typeof record.value === 'string' ? record.value : JSON.stringify(record.value));
                    }
                    cursor.continue();
                } else {
                    flushPendingWrites();
                    readyResolve();
                }
            };
            request.onerror = () => {
                if (workspace) { readyReject(request.error || new Error('Workspace load failed')); return; }
                console.warn('Failed to prime storage cache from IndexedDB', request.error);
                flushPendingWrites();
                readyResolve();
            };
        }).catch(err => {
            if (workspace) { readyReject(err); return; }
            console.warn('IndexedDB unavailable for persistence, falling back to in-memory cache only', err);
            readyResolve();
        });
    }

    function persistPair(key, value) {
        if (!hasIndexedDB) {
            return;
        }
        if (!dbName || !loadStarted) { pendingWrites.push({ type: 'put', key, value }); return; }
        openDb().then(db => {
            assertWorkspaceWritable();
            const transaction = db.transaction(STORE_NAME, 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            store.put({ key, value });
        }).catch(err => {
            console.warn('Failed to persist value to IndexedDB', key, err);
        });
    }

    function removePair(key) {
        if (!hasIndexedDB) {
            return;
        }
        if (!dbName || !loadStarted) { pendingWrites.push({ type: 'delete', key }); return; }
        openDb().then(db => {
            assertWorkspaceWritable();
            const transaction = db.transaction(STORE_NAME, 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            store.delete(key);
        }).catch(err => {
            console.warn('Failed to remove value from IndexedDB', key, err);
        });
    }

    function clearStore() {
        if (!hasIndexedDB) {
            return;
        }
        if (!dbName || !loadStarted) { pendingWrites.push({ type: 'clear' }); return; }
        openDb().then(db => {
            assertWorkspaceWritable();
            const transaction = db.transaction(STORE_NAME, 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            store.clear();
            if (workspace) store.put({ key: WORKSPACE_INITIALIZED_KEY, value: '1' });
        }).catch(err => {
            console.warn('Failed to clear IndexedDB store', err);
        });
    }

    function ensureReady(callback) {
        if (!callback) return;
        ready.then(() => {
            try { callback(); } catch (_) { }
        });
    }

    const PersistentStorage = {
        ready,
        getItem(key) {
            const strKey = key != null ? String(key) : '';
            if (cache.has(strKey)) {
                return cache.get(strKey);
            }
            return null;
        },
        setItem(key, value) {
            assertWorkspaceWritable();
            const strKey = key != null ? String(key) : '';
            const strValue = value != null ? String(value) : '';
            cache.set(strKey, strValue);
            if (!isMemoryOnlyKey(strKey)) persistPair(strKey, strValue);
            else if (storedMemoryOnlyKeys.delete(strKey)) removePair(strKey);
        },
        removeItem(key) {
            assertWorkspaceWritable();
            const strKey = key != null ? String(key) : '';
            cache.delete(strKey);
            if (!isMemoryOnlyKey(strKey)) removePair(strKey);
            else if (storedMemoryOnlyKeys.delete(strKey)) removePair(strKey);
        },
        clear() {
            assertWorkspaceWritable();
            cache.clear();
            storedMemoryOnlyKeys.clear();
            clearStore();
        },
        key(index) {
            if (index === undefined || index === null) return null;
            const idx = Number(index);
            if (!Number.isFinite(idx) || idx < 0) return null;
            return Array.from(cache.keys())[idx] || null;
        },
        get length() {
            return cache.size;
        },
        forEach(iterator) {
            if (typeof iterator !== 'function') return;
            cache.forEach((value, key) => {
                try { iterator(value, key); } catch (_) { }
            });
        },
        ensureReady,
        atomicWrite,
        isDerivedParcelId,
        isMemoryOnlyKey,

        // Bind once, after the tab has exclusively claimed its own durable workspace.
        setScope(cityId) {
            const scope = cityId && String(cityId).trim();
            if (scopeBinding || dbName) return ready;
            scopeBinding = true;
            if (globalScope.__CB_WORKSPACE_REQUIRED__ && !workspace) {
                readyReject(new Error('Workspace ownership is unavailable.'));
                return ready;
            }
            Promise.resolve(workspace?.ready).then(async () => {
                // Keep application startup pending in a refused tab. It must never load or replay
                // a private cache that could later overwrite the active editor's saved records.
                if (workspace && workspace.status !== 'ready') return;
                dbName = workspace ? workspace.databaseName(scope || 'global')
                    : scope ? `${DB_NAME_PREFIX}::${scope}` : LEGACY_DB_NAME;
                announceDatabase();
                if (workspace) await initializeWorkspace(scope || 'global');
                loadCache();
            }).catch(readyReject);
            return ready;
        },

        // The database this page reads and writes, or null before a scope is bound.
        databaseName() {
            return dbName;
        },

        // Every city's database, for the "erase all local data" action. Cities are separate stores,
        // so wiping one is no longer necessary to visit another — but wiping *everything* still is.
        listDatabaseNames() {
            if (!hasIndexedDB || typeof globalScope.indexedDB.databases !== 'function') {
                return Promise.resolve([LEGACY_DB_NAME]);
            }
            return globalScope.indexedDB.databases()
                .then(list => list.map(entry => entry && entry.name).filter(name => typeof name === 'string' && name.startsWith(DB_NAME_PREFIX)))
                .catch(() => [LEGACY_DB_NAME]);
        }
    };

    globalScope.PersistentStorage = PersistentStorage;
    // No eager load: the database to open depends on the city, which city-config resolves next.
    // Anything that reads before then sees the same empty cache it always did.
    // Safety net for any page that loads this without city-config: never leave `ready` unresolved.
    if (globalScope.addEventListener) {
        globalScope.addEventListener('DOMContentLoaded', () => { if (!loadStarted && !scopeBinding) PersistentStorage.setScope(null); });
    }
})();
