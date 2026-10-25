import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { create, isWorkKey, SESSION_KEY, LATEST_KEY } = require('../../frontend/js/browser-workspace.js');

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

function browserRoot({ localStorage = memoryStorage(), sessionStorage = memoryStorage(), locks = null, ids = [], visibilityState = 'hidden' } = {}) {
    const listeners = new Map();
    let idIndex = 0;
    const root = {
        localStorage,
        sessionStorage,
        navigator: locks ? { locks } : {},
        crypto: { randomUUID: () => ids[idIndex++] || `workspace-${String(idIndex).padStart(8, '0')}` },
        document: { visibilityState },
        location: { reload() { root.reloaded = true; } },
        addEventListener(name, callback) {
            if (!listeners.has(name)) listeners.set(name, []);
            listeners.get(name).push(callback);
        },
        fire(name, event = {}) { (listeners.get(name) || []).forEach(callback => callback(event)); }
    };
    return root;
}

// A tiny Web Locks model: leases remain held until the owning document fires pagehide.
function fakeLocks() {
    const held = new Set();
    const locks = {
        requests: [],
        request(name, options, callback) {
            this.requests.push({ name, options });
            if (held.has(name)) return Promise.resolve(callback(null));
            held.add(name);
            let value;
            try { value = callback({ name }); }
            catch (error) { held.delete(name); throw error; }
            return Promise.resolve(value).then(async result => {
                held.delete(name);
                return result;
            }, error => {
                held.delete(name);
                throw error;
            });
        },
        release() {}
    };
    locks.held = held;
    return locks;
}

describe('BrowserWorkspace', () => {
    it('identifies only local authoring inputs as work keys', () => {
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

    it('snapshots legacy local work on first entry while leaving preferences shared', async () => {
        const localStorage = memoryStorage({
            'consensus-builder.proposal-drafts.v3': '[{"id":"draft"}]',
            cb_current_city: 'zagreb',
            'cb_parcel_source:zagreb': 'source-a',
            theme: 'dark'
        });
        const locks = fakeLocks();
        const root = browserRoot({ localStorage, locks, ids: ['first-workspace-id'] });
        const workspace = create(root);
        await workspace.ready;

        expect(workspace.storage.getItem('consensus-builder.proposal-drafts.v3')).toContain('draft');
        expect(workspace.storage.getItem('cb_current_city')).toBe('zagreb');
        expect(localStorage.getItem(`consensus-builder.workspace:${workspace.id}:cb_current_city`)).toBe('zagreb');
        expect(localStorage.getItem('cb_current_city')).toBe('zagreb');
        expect(workspace.storage.getItem('theme')).toBe('dark');
        workspace.storage.setItem('theme', 'light');
        expect(localStorage.getItem('theme')).toBe('light');
        expect(localStorage.getItem(`consensus-builder.workspace:${workspace.id}:theme`)).toBeNull();
        expect(root.sessionStorage.getItem(SESSION_KEY)).toBe(workspace.id);
        expect(localStorage.getItem(LATEST_KEY)).toBe(workspace.id);
    });

    it('reclaims the same identity and saved work on reload after pagehide releases the lease', async () => {
        const localStorage = memoryStorage();
        const sessionStorage = memoryStorage();
        const locks = fakeLocks();
        const firstRoot = browserRoot({ localStorage, sessionStorage, locks, ids: ['reload-workspace-id'] });
        const first = create(firstRoot);
        await first.ready;
        first.storage.setItem('cb_current_city', 'split');
        first.storage.setItem('consensus-builder.proposal-drafts.v3', 'drafts-v1');
        firstRoot.fire('pagehide');
        await Promise.resolve();
        await Promise.resolve();

        const reload = create(browserRoot({ localStorage, sessionStorage, locks, ids: ['should-not-be-used'] }));
        await reload.ready;
        expect(reload.id).toBe(first.id);
        expect(reload.sourceId).toBe(first.id);
        expect(reload.storage.getItem('cb_current_city')).toBe('split');
        expect(reload.storage.getItem('consensus-builder.proposal-drafts.v3')).toBe('drafts-v1');
    });

    it('forks a duplicated session into a distinct workspace copied from its source', async () => {
        const localStorage = memoryStorage();
        const firstSession = memoryStorage();
        const locks = fakeLocks();
        const firstRoot = browserRoot({ localStorage, sessionStorage: firstSession, locks, ids: ['parent-workspace-id'] });
        const first = create(firstRoot);
        await first.ready;
        first.storage.setItem('cb_current_city', 'zagreb');
        first.storage.setItem('consensus-builder.proposal-drafts.v3', 'parent-draft');

        const clonedSession = memoryStorage({ [SESSION_KEY]: first.id });
        const duplicate = create(browserRoot({ localStorage, sessionStorage: clonedSession, locks, ids: ['duplicate-workspace-id'] }));
        await duplicate.ready;
        expect(duplicate.id).not.toBe(first.id);
        expect(duplicate.sourceId).toBe(first.id);
        expect(duplicate.storage.getItem('cb_current_city')).toBe('zagreb');
        expect(duplicate.storage.getItem('consensus-builder.proposal-drafts.v3')).toBe('parent-draft');
        expect(localStorage.getItem(`consensus-builder.workspace:${duplicate.id}:cb_current_city`)).toBe('zagreb');
        expect(first.storage.getItem('cb_current_city')).toBe('zagreb');
        expect(first.databaseName('zagreb')).not.toBe(duplicate.databaseName('zagreb'));
        expect(duplicate.sourceDatabaseName('zagreb')).toBe(`consensus-builder-storage::workspace:${first.id}::zagreb`);
    });

    it('persists source ancestry so an untouched city can search ancestors after reload', async () => {
        const localStorage = memoryStorage({
            'consensus-builder.workspace:source-parent-id:sources': JSON.stringify(['source-grandparent-id'])
        });
        const locks = fakeLocks();
        const parentSession = memoryStorage({ [SESSION_KEY]: 'source-parent-id' });
        const parentRoot = browserRoot({ localStorage, sessionStorage: parentSession, locks });
        const parent = create(parentRoot);
        await parent.ready;

        const duplicateSession = memoryStorage({ [SESSION_KEY]: parent.id });
        const duplicateRoot = browserRoot({ localStorage, sessionStorage: duplicateSession, locks, ids: ['ancestry-child-id'] });
        const duplicate = create(duplicateRoot);
        await duplicate.ready;
        expect(duplicate.sourceDatabaseNames('split')).toEqual([
            `consensus-builder-storage::workspace:${parent.id}::split`,
            'consensus-builder-storage::workspace:source-grandparent-id::split',
            'consensus-builder-storage::split'
        ]);
        const childId = duplicate.id;
        const childSources = localStorage.getItem(`consensus-builder.workspace:${childId}:sources`);
        expect(JSON.parse(childSources)).toEqual([parent.id, 'source-grandparent-id']);

        duplicateSession.setItem(SESSION_KEY, childId);
        // A reload reclaims the same id after its document releases the lease.
        duplicateRoot.fire('pagehide');
        await Promise.resolve();
        await Promise.resolve();
        const reloaded = create(browserRoot({ localStorage, sessionStorage: duplicateSession, locks, ids: ['ignored-child-id'] }));
        await reloaded.ready;
        expect(reloaded.id).toBe(childId);
        expect(reloaded.sourceDatabaseNames('split')).toEqual(duplicate.sourceDatabaseNames('split'));
    });

    it('does not let simultaneous documents with one session own the same workspace id', async () => {
        const localStorage = memoryStorage();
        const sharedSession = memoryStorage({ [SESSION_KEY]: 'shared-session-id' });
        const locks = fakeLocks();
        const a = create(browserRoot({ localStorage, sessionStorage: sharedSession, locks, ids: ['forked-tab-id-a'] }));
        const b = create(browserRoot({ localStorage, sessionStorage: memoryStorage({ [SESSION_KEY]: 'shared-session-id' }), locks, ids: ['forked-tab-id-b'] }));
        await Promise.all([a.ready, b.ready]);
        expect(a.id).not.toBe(b.id);
        expect(a.databaseName('zagreb')).not.toBe(b.databaseName('zagreb'));
        expect(locks.requests.filter(request => request.options.ifAvailable === true)).toHaveLength(3);
        expect(locks.held.size).toBe(2);
    });

    it('forks and restores work without Web Locks', async () => {
        const localStorage = memoryStorage({ 'cb_current_city': 'rijeka', theme: 'dark' });
        const sessionStorage = memoryStorage({ [SESSION_KEY]: 'old-workspace-id' });
        const original = create(browserRoot({ localStorage, sessionStorage: memoryStorage(), ids: ['old-workspace-id'] }));
        await original.ready;
        original.storage.setItem('cb_current_city', 'rijeka');

        const noLockSession = memoryStorage({ [SESSION_KEY]: original.id });
        const tab = create(browserRoot({ localStorage, sessionStorage: noLockSession, ids: ['no-lock-fork-id'] }));
        await tab.ready;
        expect(tab.id).not.toBe(original.id);
        expect(tab.sourceId).toBe(original.id);
        expect(tab.storage.getItem('cb_current_city')).toBe('rijeka');
        expect(localStorage.getItem(`consensus-builder.workspace:${tab.id}:cb_current_city`)).toBe('rijeka');
        expect(tab.storage.getItem('theme')).toBe('dark');
    });

    it('isolates drafts, selected city and per-city source choices between workspaces', async () => {
        const localStorage = memoryStorage();
        const locks = fakeLocks();
        const first = create(browserRoot({ localStorage, locks, ids: ['isolation-workspace-one'] }));
        await first.ready;
        const second = create(browserRoot({ localStorage, locks, ids: ['isolation-workspace-two'] }));
        await second.ready;

        first.storage.setItem('consensus-builder.proposal-drafts.v3', 'draft-one');
        first.storage.setItem('cb_current_city', 'zagreb');
        first.storage.setItem('cb_parcel_source:zagreb', 'source-one');
        first.storage.setItem('cb_estimated_parcels:zagreb', 'estimate-one');
        second.storage.setItem('consensus-builder.proposal-drafts.v3', 'draft-two');
        second.storage.setItem('cb_current_city', 'split');
        second.storage.setItem('cb_parcel_source:zagreb', 'source-two');
        second.storage.setItem('cb_estimated_parcels:zagreb', 'estimate-two');

        expect(first.storage.getItem('consensus-builder.proposal-drafts.v3')).toBe('draft-one');
        expect(second.storage.getItem('consensus-builder.proposal-drafts.v3')).toBe('draft-two');
        expect(first.storage.getItem('cb_current_city')).toBe('zagreb');
        expect(second.storage.getItem('cb_current_city')).toBe('split');
        expect(first.storage.getItem('cb_parcel_source:zagreb')).toBe('source-one');
        expect(second.storage.getItem('cb_parcel_source:zagreb')).toBe('source-two');
        expect(localStorage.getItem('cb_parcel_source:zagreb')).toBeNull();
        expect(first.databaseName('zagreb')).not.toBe(second.databaseName('zagreb'));
    });
});
