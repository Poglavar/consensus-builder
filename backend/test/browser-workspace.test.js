import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const api = require('../../frontend/js/browser-workspace.js');
const { create, isWorkKey, WORKSPACE_KEY } = api;

function memoryStorage(seed = {}) {
    const values = new Map(Object.entries(seed).map(([key, value]) => [key, String(value)]));
    return {
        values,
        get length() { return values.size; },
        key(index) { return Array.from(values.keys())[index] ?? null; },
        getItem(key) { return values.get(String(key)) ?? null; },
        setItem(key, value) { values.set(String(key), String(value)); },
        removeItem(key) { values.delete(String(key)); }
    };
}

function fakeLocks() {
    const held = new Set();
    return {
        held,
        requests: [],
        request(name, options, callback) {
            this.requests.push({ name, options });
            if (held.has(name)) return Promise.resolve(callback(null));
            held.add(name);
            let result;
            try { result = callback({ name }); }
            catch (error) { held.delete(name); throw error; }
            return Promise.resolve(result).finally(() => held.delete(name));
        }
    };
}

function browserRoot({ localStorage = memoryStorage(), locks = fakeLocks(), id = 'candidate-workspace-id' } = {}) {
    const listeners = new Map();
    const root = {
        localStorage,
        navigator: locks ? { locks } : {},
        crypto: { randomUUID: () => id },
        document: { visibilityState: 'hidden' },
        location: { reload() { root.reloaded = true; } },
        addEventListener(name, callback) {
            if (!listeners.has(name)) listeners.set(name, []);
            listeners.get(name).push(callback);
        },
        fire(name, event = {}) { (listeners.get(name) || []).forEach(callback => callback(event)); }
    };
    return root;
}

describe('BrowserWorkspace single owner', () => {
    it('exports one durable identity key and recognizes workspace authoring keys', () => {
        expect(WORKSPACE_KEY).toBe('cb.workspace.latest.v1');
        expect(api).not.toHaveProperty('SESSION_KEY');
        expect(api).not.toHaveProperty('LATEST_KEY');
        for (const key of [
            'consensus-builder.proposal-drafts.v3', 'cb_current_city', 'cb_explore_at',
            'cb.schelling.settings', 'cb.epoch.lastUsed', 'cb_estimated_parcels:zagreb',
            'cb_economic_source:zagreb', 'cb_parcel_source:zagreb',
            'cb_building_source:zagreb', 'cb_imagery_source:zagreb'
        ]) expect(isWorkKey(key), key).toBe(true);
        for (const key of ['theme', 'language', 'cb_current_city_old', 'cb_parcel_source', 'unrelated']) {
            expect(isWorkKey(key), key).toBe(false);
        }
    });

    it('lets one tab own the saved workspace and blocks a duplicate without writing', async () => {
        const localStorage = memoryStorage({
            'consensus-builder.proposal-drafts.v3': 'saved-drafts',
            cb_current_city: 'zagreb',
            'cb_parcel_source:zagreb': 'source-a',
            theme: 'dark'
        });
        const locks = fakeLocks();
        const firstRoot = browserRoot({ localStorage, locks, id: 'saved-workspace-id' });
        const first = create(firstRoot);
        await expect(first.ready).resolves.toBe(true);
        expect(first.status).toBe('ready');
        expect(localStorage.getItem(WORKSPACE_KEY)).toBe(first.id);

        const snapshotBeforeDuplicate = Object.fromEntries(localStorage.values);
        const duplicate = create(browserRoot({ localStorage, locks, id: 'must-not-persist-id' }));
        await expect(duplicate.ready).resolves.toBe(false);
        expect(duplicate.status).toBe('blocked');
        expect(duplicate.id).toBe(first.id);
        expect(Object.fromEntries(localStorage.values)).toEqual(snapshotBeforeDuplicate);
        expect(() => duplicate.storage.setItem('cb_current_city', 'split')).toThrow();
        expect(() => duplicate.storage.removeItem('consensus-builder.proposal-drafts.v3')).toThrow();
        expect(Object.fromEntries(localStorage.values)).toEqual(snapshotBeforeDuplicate);
        expect(first.storage.getItem('theme')).toBe('dark');
        first.storage.setItem('theme', 'light');
        expect(localStorage.getItem('theme')).toBe('light');
    });

    it('serializes simultaneous first tabs with different candidate identities', async () => {
        const localStorage = memoryStorage();
        const locks = fakeLocks();
        const a = create(browserRoot({ localStorage, locks, id: 'candidate-workspace-a' }));
        const b = create(browserRoot({ localStorage, locks, id: 'candidate-workspace-b' }));
        const results = await Promise.all([a.ready, b.ready]);

        expect(results.sort()).toEqual([false, true]);
        const owner = a.status === 'ready' ? a : b;
        const blocked = owner === a ? b : a;
        expect(owner.status).toBe('ready');
        expect(blocked.status).toBe('blocked');
        expect(localStorage.getItem(WORKSPACE_KEY)).toBe(owner.id);
        expect(blocked.id).toBe(localStorage.getItem(WORKSPACE_KEY));
        expect(new Set(locks.requests.map(request => request.name)).size).toBe(1);
    });

    it('buffers work writes while loading and publishes them only after lease ownership', async () => {
        let callback;
        let release;
        const locks = {
            request: (_name, _options, onLock) => {
                callback = onLock;
                return new Promise(resolve => { release = resolve; });
            }
        };
        const localStorage = memoryStorage();
        const workspace = create(browserRoot({ localStorage, locks, id: 'buffered-workspace-id' }));
        expect(workspace.status).toBe('loading');
        workspace.storage.setItem('cb_current_city', 'zagreb');
        expect(localStorage.getItem('cb_current_city')).toBeNull();
        await Promise.resolve();
        callback({ name: 'workspace' });
        await expect(workspace.ready).resolves.toBe(true);
        expect(workspace.status).toBe('ready');
        expect(localStorage.getItem(`consensus-builder.workspace:${workspace.id}:cb_current_city`)).toBe('zagreb');
        release();
    });

    it('adopts identity and latest saved data when its deferred first lock arrives late', async () => {
        const localStorage = memoryStorage();
        let grant;
        const deferredLocks = {
            request: (_name, _options, callback) => {
                grant = callback;
                return new Promise(() => {});
            }
        };
        const waiting = create(browserRoot({ localStorage, locks: deferredLocks, id: 'waiting-candidate-id' }));
        await Promise.resolve();
        expect(waiting.status).toBe('loading');

        const establisherRoot = browserRoot({ localStorage, id: 'established-profile-id' });
        const establisher = create(establisherRoot);
        await expect(establisher.ready).resolves.toBe(true);
        establisher.storage.setItem('consensus-builder.proposal-drafts.v3', 'latest-draft');
        establisherRoot.fire('pagehide');
        await new Promise(resolve => setTimeout(resolve, 0));

        grant({ name: 'workspace' });
        await expect(waiting.ready).resolves.toBe(true);
        expect(waiting.id).toBe('established-profile-id');
        expect(waiting.id).not.toBe('waiting-candidate-id');
        expect(waiting.storage.getItem('consensus-builder.proposal-drafts.v3')).toBe('latest-draft');
        expect(localStorage.getItem('consensus-builder.workspace:waiting-candidate-id:consensus-builder.proposal-drafts.v3')).toBeNull();
    });

    it('reads back the durable value after a silent localStorage write loss', async () => {
        const id = 'readback-workspace-id';
        const key = `consensus-builder.workspace:${id}:cb_current_city`;
        const localStorage = memoryStorage({
            [WORKSPACE_KEY]: id,
            [key]: 'zagreb'
        });
        const setItem = localStorage.setItem.bind(localStorage);
        localStorage.setItem = (writeKey, value) => {
            if (String(writeKey) === key) return;
            setItem(writeKey, value);
        };
        const workspace = create(browserRoot({ localStorage, id: 'ignored-candidate-id' }));
        await expect(workspace.ready).resolves.toBe(true);
        workspace.storage.setItem('cb_current_city', 'split');
        expect(workspace.storage.getItem('cb_current_city')).toBe('zagreb');
        expect(localStorage.getItem(key)).toBe('zagreb');
    });

    it('reuses the same identity and saved authoring state after close with a new tab session', async () => {
        const localStorage = memoryStorage();
        const locks = fakeLocks();
        const firstRoot = browserRoot({ localStorage, locks, id: 'persistent-profile-id' });
        const first = create(firstRoot);
        await first.ready;
        first.storage.setItem('consensus-builder.proposal-drafts.v3', 'draft-v1');
        first.storage.setItem('cb_current_city', 'split');
        first.storage.setItem('cb_parcel_source:split', 'source-split');
        firstRoot.fire('pagehide');
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(first.status).toBe('closed');

        const second = create(browserRoot({ localStorage, locks, id: 'not-the-profile-id' }));
        await expect(second.ready).resolves.toBe(true);
        expect(second.id).toBe(first.id);
        expect(second.storage.getItem('consensus-builder.proposal-drafts.v3')).toBe('draft-v1');
        expect(second.storage.getItem('cb_current_city')).toBe('split');
        expect(second.storage.getItem('cb_parcel_source:split')).toBe('source-split');
        expect(second.databaseName('split')).toBe(first.databaseName('split'));
    });

    it('does not persist identity or buffered work when the global lease is unavailable', async () => {
        const locks = fakeLocks();
        const localStorage = memoryStorage();
        const owner = create(browserRoot({ localStorage, locks, id: 'owner-profile-id' }));
        await owner.ready;
        const before = Object.fromEntries(localStorage.values);
        const blocked = create(browserRoot({ localStorage, locks, id: 'candidate-only-id' }));
        blocked.storage.setItem('cb_current_city', 'must-not-save');
        await expect(blocked.ready).resolves.toBe(false);
        expect(blocked.status).toBe('blocked');
        expect(() => blocked.storage.setItem('cb_current_city', 'still-must-not-save')).toThrow();
        expect(Object.fromEntries(localStorage.values)).toEqual(before);
    });

    it('fails closed without Web Locks', async () => {
        const localStorage = memoryStorage({ 'cb_current_city': 'legacy-city' });
        const root = browserRoot({ localStorage, locks: null, id: 'unsupported-candidate-id' });
        root.navigator = {};
        const workspace = create(root);
        await expect(workspace.ready).resolves.toBe(false);
        expect(workspace.status).toBe('unsupported');
        expect(localStorage.getItem(WORKSPACE_KEY)).toBeNull();
        expect(() => workspace.storage.setItem('cb_current_city', 'split')).toThrow();
        expect(localStorage.getItem('cb_current_city')).toBe('legacy-city');
    });

    it('reloads a persisted page when restored from the back-forward cache', async () => {
        const root = browserRoot({ localStorage: memoryStorage(), id: 'bfcache-workspace-id' });
        const workspace = create(root);
        await workspace.ready;
        root.fire('pageshow', { persisted: true });
        expect(root.reloaded).toBe(true);
    });
});
