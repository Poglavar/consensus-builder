// Per-city key/value storage on IndexedDB.
//
// Each city gets its own database, so the data of one city can never be mistaken for another's.
// That is what lets switching cities be a navigation rather than a demolition: nothing has to be
// erased, and the city you leave is still there when you come back.
//
// Which database to open is decided by PersistentStorage.setScope(cityId), called by city-config as
// soon as it resolves the current city — before anything reads. Callers that never set a scope (the
// standalone pages) fall back to the legacy, unscoped database.
(function () {
    const globalScope = typeof window !== 'undefined' ? window : self;
    const hasIndexedDB = typeof globalScope.indexedDB !== 'undefined';

    const DB_NAME_PREFIX = 'consensus-builder-storage';
    // Everything written before cities had their own database. Migrated once, into whichever city
    // it belonged to, then left in place rather than deleted.
    const LEGACY_DB_NAME = DB_NAME_PREFIX;
    const LEGACY_MIGRATED_KEY = '__migrated_to_city_scope';
    const CITY_POINTER_KEY = 'cb_current_city';
    const DB_VERSION = 1;
    const STORE_NAME = 'kv';

    const cache = new Map();
    let dbInstance = null;
    let dbName = null;           // resolved by setScope(), or lazily to the legacy name
    let loadStarted = false;
    let readyResolve;
    const ready = new Promise(resolve => {
        readyResolve = resolve;
    });

    // Writes issued before a city is bound. They must not be guessed into the legacy database:
    // that store belongs to the pre-upgrade world, and a stray write there would go to a city the
    // user is not in. Held here and flushed once the scope is known.
    const pendingWrites = [];

    function resolveDbName() {
        if (dbName) return dbName;
        dbName = LEGACY_DB_NAME; // no scope was ever set (a page without city-config)
        return dbName;
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
        return new Promise((resolve, reject) => {
            const request = globalScope.indexedDB.open(resolveDbName(), DB_VERSION);
            request.onupgradeneeded = event => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'key' });
                }
            };
            request.onsuccess = () => {
                dbInstance = request.result;
                dbInstance.onversionchange = () => {
                    try { dbInstance.close(); } catch (_) { }
                    dbInstance = null;
                };
                resolve(dbInstance);
            };
            request.onerror = () => {
                reject(request.error || new Error('IndexedDB open failed'));
            };
            request.onblocked = () => {
                console.warn('IndexedDB upgrade blocked for consensus-builder storage');
            };
        });
    }

    // Read every row of an arbitrary database without disturbing the module's own connection.
    // Resolves to a plain object; resolves empty when the database does not exist or cannot be read.
    function readAllFrom(name) {
        if (!hasIndexedDB) return Promise.resolve({});
        return new Promise(resolve => {
            let request;
            try {
                request = globalScope.indexedDB.open(name, DB_VERSION);
            } catch (_) {
                resolve({});
                return;
            }
            let created = false;
            request.onupgradeneeded = event => {
                // The database did not exist. Create the store so the open succeeds, note that we
                // created it, and return nothing — there is no legacy data to migrate.
                created = true;
                const db = event.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'key' });
                }
            };
            request.onerror = () => resolve({});
            request.onblocked = () => resolve({});
            request.onsuccess = () => {
                const db = request.result;
                if (created) {
                    try { db.close(); } catch (_) { }
                    resolve({});
                    return;
                }
                try {
                    const out = {};
                    const transaction = db.transaction(STORE_NAME, 'readonly');
                    const cursorRequest = transaction.objectStore(STORE_NAME).openCursor();
                    cursorRequest.onsuccess = event => {
                        const cursor = event.target.result;
                        if (cursor) {
                            const record = cursor.value;
                            if (record && typeof record.key === 'string') {
                                out[record.key] = typeof record.value === 'string' ? record.value : JSON.stringify(record.value);
                            }
                            cursor.continue();
                        } else {
                            try { db.close(); } catch (_) { }
                            resolve(out);
                        }
                    };
                    cursorRequest.onerror = () => { try { db.close(); } catch (_) { } resolve({}); };
                } catch (_) {
                    try { db.close(); } catch (_) { }
                    resolve({});
                }
            };
        });
    }

    function writeAllTo(name, entries) {
        if (!hasIndexedDB || !entries || !Object.keys(entries).length) return Promise.resolve();
        return new Promise(resolve => {
            const request = globalScope.indexedDB.open(name, DB_VERSION);
            request.onupgradeneeded = event => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'key' });
                }
            };
            request.onerror = () => resolve();
            request.onblocked = () => resolve();
            request.onsuccess = () => {
                const db = request.result;
                try {
                    const transaction = db.transaction(STORE_NAME, 'readwrite');
                    const store = transaction.objectStore(STORE_NAME);
                    Object.keys(entries).forEach(key => store.put({ key, value: entries[key] }));
                    transaction.oncomplete = () => { try { db.close(); } catch (_) { } resolve(); };
                    transaction.onerror = () => { try { db.close(); } catch (_) { } resolve(); };
                } catch (_) {
                    try { db.close(); } catch (_) { }
                    resolve();
                }
            };
        });
    }

    // One-time move of the old single database into the city it actually belonged to — the city it
    // recorded as current. Runs before the cache is primed, so the app never sees the gap. The
    // legacy database is marked and left alone rather than deleted; it costs nothing and a botched
    // migration should not be the thing that loses someone's proposals.
    //
    // Returns the city the legacy data belongs to, or null. That matters because an upgrading user's
    // last city was recorded *only* in this database, which cannot be read synchronously — so the
    // boot before this ran had to guess, and may have guessed the default.
    async function migrateLegacyDatabase() {
        if (!hasIndexedDB) return null;
        try {
            const legacy = await readAllFrom(LEGACY_DB_NAME);
            const keys = Object.keys(legacy);
            if (!keys.length || legacy[LEGACY_MIGRATED_KEY]) return null;

            const legacyCity = legacy[CITY_POINTER_KEY];
            if (!legacyCity) return null; // nothing tells us whose data this is; leave it untouched

            const target = `${DB_NAME_PREFIX}::${legacyCity}`;
            const existing = await readAllFrom(target);
            if (Object.keys(existing).length) return legacyCity; // already populated; never overwrite

            await writeAllTo(target, legacy);
            await writeAllTo(LEGACY_DB_NAME, { [LEGACY_MIGRATED_KEY]: '1' });
            console.info(`[PersistentStorage] Migrated legacy local data into ${target}`);
            return legacyCity;
        } catch (error) {
            console.warn('[PersistentStorage] Legacy migration failed; leaving data in place', error);
            return null;
        }
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
                    if (record && typeof record.key === 'string' && !cache.has(record.key)) {
                        cache.set(record.key, typeof record.value === 'string' ? record.value : JSON.stringify(record.value));
                    }
                    cursor.continue();
                } else {
                    flushPendingWrites();
                    readyResolve();
                }
            };
            request.onerror = () => {
                console.warn('Failed to prime storage cache from IndexedDB', request.error);
                flushPendingWrites();
                readyResolve();
            };
        }).catch(err => {
            console.warn('IndexedDB unavailable for persistence, falling back to in-memory cache only', err);
            readyResolve();
        });
    }

    function persistPair(key, value) {
        if (!hasIndexedDB) {
            return;
        }
        if (!dbName) { pendingWrites.push({ type: 'put', key, value }); return; }
        openDb().then(db => {
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
        if (!dbName) { pendingWrites.push({ type: 'delete', key }); return; }
        openDb().then(db => {
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
        if (!dbName) { pendingWrites.push({ type: 'clear' }); return; }
        openDb().then(db => {
            const transaction = db.transaction(STORE_NAME, 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            store.clear();
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
            const strKey = key != null ? String(key) : '';
            const strValue = value != null ? String(value) : '';
            cache.set(strKey, strValue);
            persistPair(strKey, strValue);
        },
        removeItem(key) {
            const strKey = key != null ? String(key) : '';
            cache.delete(strKey);
            removePair(strKey);
        },
        clear() {
            cache.clear();
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

        // Bind this browser session to one city's database. Called once by city-config, before
        // anything reads. Migrates the pre-city-scope database on first run.
        //
        // `explicit` says whether the city was actually chosen (a ?city= param, or a pointer this
        // browser had already saved) rather than merely defaulted to. On the very first load after
        // the upgrade an existing user has no saved pointer — their last city is locked inside the
        // legacy database, which only becomes readable here. If it turns out they were somewhere
        // other than the default, adopt it and reload once, so they land where they left off instead
        // of staring at an empty New York.
        setScope(cityId, options) {
            const explicit = !!(options && options.explicit);
            const scope = (cityId && String(cityId).trim()) ? String(cityId).trim() : null;
            if (!scope || dbName) {
                // Either no city to scope by, or a scope is already bound: prime whatever we have.
                loadCache();
                return ready;
            }
            dbName = `${DB_NAME_PREFIX}::${scope}`;
            migrateLegacyDatabase().then(legacyCity => {
                if (!explicit && legacyCity && legacyCity !== scope) {
                    try {
                        globalScope.localStorage.setItem(CITY_POINTER_KEY, legacyCity);
                        console.info(`[PersistentStorage] Recovered last city "${legacyCity}"; reloading.`);
                        globalScope.location.reload();
                        return;
                    } catch (_) { /* fall through and just prime the default city */ }
                }
                loadCache();
            });
            return ready;
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
        globalScope.addEventListener('DOMContentLoaded', () => { if (!loadStarted) loadCache(); });
    }
})();
