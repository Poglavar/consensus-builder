(function () {
    const globalScope = typeof window !== 'undefined' ? window : self;
    const nativeLocalStorage = (() => {
        try {
            return globalScope.PersistentStorage || null;
        } catch (_) {
            return null;
        }
    })();
    const hasIndexedDB = typeof globalScope.indexedDB !== 'undefined';

    const DB_NAME = 'consensus-builder-storage';
    const DB_VERSION = 1;
    const STORE_NAME = 'kv';

    const cache = new Map();
    let dbInstance = null;
    let readyResolve;
    const ready = new Promise(resolve => {
        readyResolve = resolve;
    });

    function openDb() {
        if (!hasIndexedDB) {
            return Promise.reject(new Error('IndexedDB unavailable'));
        }
        if (dbInstance) {
            return Promise.resolve(dbInstance);
        }
        return new Promise((resolve, reject) => {
            const request = globalScope.indexedDB.open(DB_NAME, DB_VERSION);
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

    function loadCache() {
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
                    if (record && typeof record.key === 'string') {
                        cache.set(record.key, typeof record.value === 'string' ? record.value : JSON.stringify(record.value));
                    }
                    cursor.continue();
                } else {
                    readyResolve();
                }
            };
            request.onerror = () => {
                console.warn('Failed to prime storage cache from IndexedDB', request.error);
                readyResolve();
            };
        }).catch(err => {
            console.warn('IndexedDB unavailable for persistence, falling back to in-memory cache only', err);
            readyResolve();
        });
    }

    function persistPair(key, value) {
        if (!hasIndexedDB) {
            if (nativeLocalStorage) {
                try { nativeLocalStorage.setItem(key, value); } catch (_) { }
            }
            return;
        }
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
            if (nativeLocalStorage) {
                try { nativeLocalStorage.removeItem(key); } catch (_) { }
            }
            return;
        }
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
            if (nativeLocalStorage) {
                try { nativeLocalStorage.clear(); } catch (_) { }
            }
            return;
        }
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
            if (!hasIndexedDB && nativeLocalStorage) {
                try { return nativeLocalStorage.getItem(strKey); } catch (_) { return null; }
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
        ensureReady
    };

    globalScope.PersistentStorage = PersistentStorage;
    loadCache();
})();
