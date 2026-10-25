// Each tab owns an independent durable working copy. Reload reclaims its lease; a duplicate
// forks the saved copy instead of becoming a second writer. City text is not workspace identity.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.BrowserWorkspace = api.create(root);
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const SESSION_KEY = 'cb.workspace.v1';
    const LATEST_KEY = 'cb.workspace.latest.v1';
    const LOCAL_PREFIX = 'consensus-builder.workspace:';
    const DB_PREFIX = 'consensus-builder-storage';
    const isId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(value);
    function isWorkKey(key) {
        return key === 'consensus-builder.proposal-drafts.v3' || key === 'cb_current_city'
            || key === 'cb_explore_at' || key === 'cb.schelling.settings' || key === 'cb.epoch.lastUsed'
            || key === 'cb_dev_backend_base' || key === 'cb_sim_url'
            || /^cb_(?:estimated_parcels|economic_source|parcel_source|building_source|imagery_source):/.test(key);
    }
    function create(root) {
        const local = root.localStorage;
        const session = root.sessionStorage;
        const read = (storage, key) => { try { return storage?.getItem(key); } catch (_) { return null; } };
        const inherited = read(session, SESSION_KEY);
        const latest = read(local, LATEST_KEY);
        let id = isId(inherited) ? inherited : root.crypto.randomUUID();
        let sourceId = isId(inherited) ? inherited : isId(latest) ? latest : null;
        let prepared = false;
        let releaseLease = null;
        let seedSources = [];
        const values = new Map(), changed = new Set();
        const sourcePrefix = sourceId ? LOCAL_PREFIX + sourceId + ':' : '';
        // Snapshot local authoring inputs before any bootstrap writes. Early setters are private
        // until the lease is resolved, so a duplicated tab can never write its parent's namespace.
        for (let i = 0; local && i < local.length; i++) {
            const rawKey = local.key(i);
            if (!rawKey || (sourcePrefix && !rawKey.startsWith(sourcePrefix))) continue;
            const key = sourcePrefix ? rawKey.slice(sourcePrefix.length) : rawKey;
            if (isWorkKey(key)) values.set(key, local.getItem(rawKey));
        }
        const keyFor = key => LOCAL_PREFIX + id + ':' + key;
        const storage = {
            getItem(key) { return isWorkKey(String(key)) ? values.get(String(key)) ?? null : local?.getItem(key) ?? null; },
            setItem(key, value) {
                key = String(key); value = String(value);
                if (!isWorkKey(key)) { local?.setItem(key, value); return; }
                values.set(key, value); changed.add(key);
                if (prepared) local?.setItem(keyFor(key), value);
            },
            removeItem(key) {
                key = String(key);
                if (!isWorkKey(key)) { local?.removeItem(key); return; }
                values.delete(key); changed.add(key);
                if (prepared) local?.removeItem(keyFor(key));
            }
        };
        let resolveReady, rejectReady;
        const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
        ready.catch(() => {}); // PersistentStorage reports a rejected boot barrier to the page.
        function own() {
            const copied = sourceId !== id;
            const parseSources = source => {
                try { return JSON.parse(read(local, LOCAL_PREFIX + source + ':sources') || '[]').filter(isId); }
                catch (_) { return []; }
            };
            seedSources = copied ? (sourceId ? [sourceId, ...parseSources(sourceId)] : []) : parseSources(id);
            local?.setItem(LOCAL_PREFIX + id + ':sources', JSON.stringify(seedSources));
            for (const key of copied ? values.keys() : changed) {
                if (values.has(key)) local?.setItem(keyFor(key), values.get(key));
                else local?.removeItem(keyFor(key));
            }
            session?.setItem(SESSION_KEY, id);
            local?.setItem(LATEST_KEY, id);
            prepared = true;
            resolveReady();
        }
        function claim() {
            if (!root.navigator?.locks?.request) {
                // Without leases, always fork on document entry, including reload. Saved work is
                // restored from the prior copy, and two documents can never share a writable DB.
                if (id === sourceId) id = root.crypto.randomUUID();
                own();
                return;
            }
            root.navigator.locks.request('consensus-builder-workspace:' + id,
                { mode: 'exclusive', ifAvailable: true }, lock => {
                    if (!lock) {
                        sourceId = id;
                        id = root.crypto.randomUUID();
                        claim();
                        return;
                    }
                    own();
                    return new Promise(resolve => { releaseLease = resolve; });
                }).catch(rejectReady);
        }
        try { claim(); } catch (error) { rejectReady(error); }
        root.addEventListener?.('pagehide', () => { releaseLease?.(); releaseLease = null; });
        root.addEventListener?.('pageshow', event => {
            if (event.persisted) root.location.reload(); // reclaim ownership before restoring a frozen page
        });
        root.addEventListener?.('visibilitychange', () => {
            if (prepared && root.document?.visibilityState === 'visible') local?.setItem(LATEST_KEY, id);
        });
        return Object.freeze({
            get id() { return id; }, get sourceId() { return sourceId; }, ready, storage,
            databaseName(city) { return `${DB_PREFIX}::workspace:${id}::${city}`; },
            sourceDatabaseName(city) {
                return sourceId === id ? null : sourceId ? `${DB_PREFIX}::workspace:${sourceId}::${city}` : `${DB_PREFIX}::${city}`;
            },
            // An untouched city may still live in an ancestor's snapshot. Stop at the first
            // initialized store, including an intentionally empty one; never merge compositions.
            sourceDatabaseNames(city) {
                return [...seedSources.map(source => `${DB_PREFIX}::workspace:${source}::${city}`), `${DB_PREFIX}::${city}`];
            }
        });
    }
    return { create, isWorkKey, SESSION_KEY, LATEST_KEY };
});
