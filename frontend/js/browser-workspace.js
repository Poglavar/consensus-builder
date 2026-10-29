// A saved workspace outlives its tabs. Exactly one map document may edit it at a time.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.BrowserWorkspace = api.create(root);
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const WORKSPACE_KEY = 'cb.workspace.latest.v1';
    const LOCAL_PREFIX = 'consensus-builder.workspace:';
    const DB_PREFIX = 'consensus-builder-storage';
    const LOCK_NAME = 'consensus-builder-saved-workspace';
    const isId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(value);
    function isWorkKey(key) {
        return key === 'consensus-builder.proposal-drafts.v3' || key === 'cb_current_city'
            || key === 'cb_explore_at' || key === 'cb.schelling.settings'
            || key === 'cb_dev_backend_base' || key === 'cb_sim_url'
            || /^cb_(?:estimated_parcels|economic_source|parcel_source|building_source|imagery_source):/.test(key);
    }
    function create(root) {
        const local = root.localStorage;
        const saved = local.getItem(WORKSPACE_KEY);
        let id = isId(saved) ? saved : root.crypto.randomUUID();
        let status = 'loading';
        let releaseLease = null;
        const values = new Map(), changed = new Set();
        const sourcePrefix = isId(saved) ? LOCAL_PREFIX + saved + ':' : '';
        // Early bootstrap writes wait behind the lease; a refused document never persists work.
        for (let i = 0; local && i < local.length; i++) {
            const rawKey = local.key(i);
            if (!rawKey || (sourcePrefix && !rawKey.startsWith(sourcePrefix))) continue;
            const key = sourcePrefix ? rawKey.slice(sourcePrefix.length) : rawKey;
            if (isWorkKey(key)) values.set(key, local.getItem(rawKey));
        }
        const keyFor = key => LOCAL_PREFIX + id + ':' + key;
        function assertWritable() {
            if (status === 'loading' || status === 'ready') return;
            const error = new Error('This tab does not own the saved workspace.');
            error.code = 'workspace-' + status;
            throw error;
        }
        const storage = {
            getItem(key) {
                key = String(key);
                if (!isWorkKey(key)) return local?.getItem(key) ?? null;
                return status === 'ready' ? local.getItem(keyFor(key)) : values.get(key) ?? null;
            },
            setItem(key, value) {
                key = String(key); value = String(value);
                if (!isWorkKey(key)) { local?.setItem(key, value); return; }
                assertWritable();
                values.set(key, value); changed.add(key);
                if (status === 'ready') local?.setItem(keyFor(key), value);
            },
            removeItem(key) {
                key = String(key);
                if (!isWorkKey(key)) { local?.removeItem(key); return; }
                assertWritable();
                values.delete(key); changed.add(key);
                if (status === 'ready') local?.removeItem(keyFor(key));
            }
        };
        let resolveReady, rejectReady;
        const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
        ready.catch(() => {});
        if (!root.navigator?.locks?.request) {
            status = 'unsupported';
            resolveReady(false);
        } else {
            // One fixed lock also fences simultaneous first visits before a saved ID exists.
            Promise.resolve().then(() => root.navigator.locks.request(LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, lock => {
                if (!lock) {
                    id = local.getItem(WORKSPACE_KEY) || id;
                    status = 'blocked';
                    resolveReady(false);
                    return;
                }
                // Re-read under the profile lock: another first visit may have saved its identity
                // and closed while this document was still loading.
                const established = local.getItem(WORKSPACE_KEY);
                if (isId(established)) id = established;
                for (const key of isId(established) ? changed : values.keys()) {
                    if (values.has(key)) local.setItem(keyFor(key), values.get(key));
                    else local.removeItem(keyFor(key));
                }
                local.setItem(WORKSPACE_KEY, id);
                status = 'ready';
                resolveReady(true);
                return new Promise(resolve => { releaseLease = resolve; });
            })).then(() => {
                if (status === 'ready') status = 'closed';
            }).catch(error => { status = 'error'; rejectReady(error); });
        }
        root.addEventListener?.('pagehide', () => { releaseLease?.(); releaseLease = null; });
        root.addEventListener?.('pageshow', event => {
            if (event.persisted) root.location.reload(); // reacquire ownership before restoring a frozen page
        });
        return Object.freeze({
            get id() { return id; }, get status() { return status; }, ready, storage,
            databaseName(city) { return `${DB_PREFIX}::workspace:${id}::${city}`; },
            sourceDatabaseNames(city) { return [`${DB_PREFIX}::${city}`]; }
        });
    }
    return { create, isWorkKey, WORKSPACE_KEY };
});
