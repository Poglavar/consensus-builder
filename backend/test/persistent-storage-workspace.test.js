import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const browserWorkspace = require('../../frontend/js/browser-workspace.js');
const storageSource = readFileSync(new URL('../../frontend/js/persistent-storage.js', import.meta.url), 'utf8');
const DB_PREFIX = 'consensus-builder-storage';
const INITIALIZED = '__workspace_initialized';

function memoryStorage(seed = {}) {
    const data = new Map(Object.entries(seed).map(([key, value]) => [key, String(value)]));
    return {
        values: data,
        get length() { return data.size; },
        key(index) { return Array.from(data.keys())[index] ?? null; },
        getItem(key) { return data.get(String(key)) ?? null; },
        setItem(key, value) { data.set(String(key), String(value)); },
        removeItem(key) { data.delete(String(key)); }
    };
}

function multiDb() {
    const databases = new Map();
    const opens = [];
    const writes = [];
    const failOpen = new Set();
    const failRead = new Set();
    const failWrite = new Set();
    function dbFor(name) {
        if (!databases.has(name)) databases.set(name, { name, rows: new Map(), hasStore: true });
        const state = databases.get(name);
        return {
            objectStoreNames: { contains: store => store === 'kv' && state.hasStore },
            createObjectStore() { state.hasStore = true; },
            close() {},
            transaction(_storeName, mode) {
                const operations = [];
                const tx = { error: null, mode, dbName: name };
                tx.objectStore = () => {
                    if (mode === 'readonly') {
                        return {
                            openCursor() {
                                const request = {};
                                const entries = Array.from(state.rows.values());
                                let index = 0;
                                const failThisRead = failRead.has(name);
                                const step = () => setTimeout(() => {
                                    if (failThisRead) {
                                        failRead.delete(name);
                                        tx.error = new Error(`read failed: ${name}`);
                                        request.error = tx.error;
                                        request.onerror?.();
                                        tx.onerror?.();
                                        return;
                                    }
                                    if (index >= entries.length) {
                                        request.onsuccess?.({ target: { result: null } });
                                        setTimeout(() => tx.oncomplete?.(), 0);
                                        return;
                                    }
                                    const value = entries[index++];
                                    request.onsuccess?.({ target: { result: { value, continue: step } } });
                                }, 0);
                                step();
                                return request;
                            }
                        };
                    }
                    const add = (kind, key, value) => {
                        operations.push([kind, key, value]);
                        const request = {};
                        request.error = null;
                        return request;
                    };
                    return {
                        put(record) { return add('put', record.key, record.value); },
                        delete(key) { return add('delete', key); },
                        clear() { return add('clear', '*'); }
                    };
                };
                if (mode === 'readwrite') {
                    writes.push({ name, operations });
                    setTimeout(() => {
                        if (failWrite.has(name)) {
                            failWrite.delete(name);
                            tx.error = new Error(`write failed: ${name}`);
                            tx.onabort?.();
                            return;
                        }
                        for (const [kind, key, value] of operations) {
                            if (kind === 'clear') state.rows.clear();
                            else if (kind === 'delete') state.rows.delete(key);
                            else state.rows.set(key, { key, value });
                        }
                        tx.oncomplete?.();
                    }, 0);
                }
                return tx;
            }
        };
    }
    const api = {
        open(name) {
            opens.push(name);
            const request = {};
            setTimeout(() => {
                if (failOpen.has(name)) {
                    failOpen.delete(name);
                    request.error = new Error(`open failed: ${name}`);
                    request.onerror?.();
                    return;
                }
                const state = databases.get(name) || (databases.set(name, { name, rows: new Map(), hasStore: false }), databases.get(name));
                request.result = dbFor(name);
                if (!state.hasStore) {
                    request.onupgradeneeded?.({ target: { result: request.result } });
                    state.hasStore = true;
                }
                request.onsuccess?.();
            }, 0);
            return request;
        },
        databases: async () => Array.from(databases.keys(), name => ({ name }))
    };
    return {
        api, databases, opens, writes, failOpen, failRead, failWrite,
        seed(name, rows) {
            const state = { name, rows: new Map(), hasStore: true };
            for (const [key, value] of Object.entries(rows)) state.rows.set(key, { key, value: String(value) });
            databases.set(name, state);
        },
        rows(name) { return Object.fromEntries(Array.from(databases.get(name)?.rows || [], ([key, row]) => [key, row.value])); }
    };
}

function fakeLocks() {
    const held = new Set();
    return {
        request(name, _options, callback) {
            if (held.has(name)) return Promise.resolve(callback(null));
            held.add(name);
            return Promise.resolve(callback({ name })).finally(() => held.delete(name));
        }
    };
}

function makeEnvironment({ fake, localStorage = memoryStorage(), id = 'test-workspace-id', locks = fakeLocks() }) {
    const listeners = new Map();
    const root = {
        localStorage, indexedDB: fake.api, navigator: locks ? { locks } : {},
        crypto: { randomUUID: () => id }, location: { reload() {} },
        document: { visibilityState: 'hidden' },
        addEventListener(name, callback) {
            if (!listeners.has(name)) listeners.set(name, []);
            listeners.get(name).push(callback);
        },
        dispatchEvent() {},
        fire(name) { (listeners.get(name) || []).forEach(callback => callback({})); }
    };
    root.BrowserWorkspace = browserWorkspace.create(root);
    const context = {
        window: root, self: root, console: { ...console, warn: vi.fn(), error: vi.fn(), info: vi.fn() },
        Promise, Map, Set, JSON, String, Number, Object, Array, CustomEvent: class { constructor(name, init) { this.type = name; this.detail = init?.detail; } },
        setTimeout, clearTimeout
    };
    vm.runInNewContext(storageSource, context);
    return { root, workspace: root.BrowserWorkspace, storage: root.PersistentStorage, fake };
}

async function scoped(options, city = 'zagreb') {
    const env = makeEnvironment(options);
    await env.workspace.ready;
    const ready = env.storage.setScope(city);
    await ready;
    return env;
}

describe('PersistentStorage workspace snapshots', () => {
    it('copies source rows and the initialized marker in one transaction, excluding derived owners', async () => {
        const fake = multiDb();
        const source = `${DB_PREFIX}::zagreb`;
        fake.seed(source, { proposals: 'saved-proposals', 'parcel_HR-1#generated_owner': 'agent-a' });
        const env = await scoped({ fake, id: 'new-workspace-id' });
        const target = env.workspace.databaseName('zagreb');

        expect(env.storage.getItem('proposals')).toBe('saved-proposals');
        expect(env.storage.getItem('parcel_HR-1#generated_owner')).toBeNull();
        expect(fake.rows(target)).toEqual({ proposals: 'saved-proposals', [INITIALIZED]: '1' });
        const copyWrites = fake.writes.find(write => write.name === target);
        expect(copyWrites.operations.map(([kind, key]) => [kind, key])).toEqual([['put', 'proposals'], ['put', INITIALIZED]]);
        expect(fake.rows(source)).toEqual({ proposals: 'saved-proposals', 'parcel_HR-1#generated_owner': 'agent-a' });
    });

    it('reloads the initialized copy without recopying newer source rows over local edits', async () => {
        const fake = multiDb();
        fake.seed(`${DB_PREFIX}::zagreb`, { proposals: 'parent-v1' });
        const localStorage = memoryStorage();
        const locks = fakeLocks();
        const first = await scoped({ fake, localStorage, locks, id: 'stable-workspace-id' });
        first.storage.setItem('proposals', 'workspace-edit');
        await new Promise(resolve => setTimeout(resolve, 10));
        first.root.fire('pagehide');
        await Promise.resolve();
        await Promise.resolve();

        const reload = await scoped({ fake, localStorage, locks, id: 'ignored-reload-id' });
        expect(reload.workspace.id).toBe(first.workspace.id);
        expect(reload.storage.getItem('proposals')).toBe('workspace-edit');
        expect(fake.rows(reload.workspace.databaseName('zagreb')).proposals).toBe('workspace-edit');
        expect(fake.writes.filter(write => write.name === reload.workspace.databaseName('zagreb')))
            .toHaveLength(2); // initial snapshot and the explicit edit; reload adds no copy transaction
    });

    it('rejects ready when reading a source snapshot fails instead of treating it as empty', async () => {
        const fake = multiDb();
        const source = `${DB_PREFIX}::zagreb`;
        fake.seed(source, { proposals: 'must-survive' });
        fake.failRead.add(source);
        const env = makeEnvironment({ fake, id: 'failed-source-read-id' });
        await env.workspace.ready;
        await expect(env.storage.setScope('zagreb')).rejects.toThrow(`read failed: ${source}`);
        await expect(env.storage.ready).rejects.toThrow(`read failed: ${source}`);
        expect(fake.rows(env.workspace.databaseName('zagreb'))).toEqual({});
    });

    it('rejects ready when writing the initialized snapshot fails', async () => {
        const fake = multiDb();
        fake.seed(`${DB_PREFIX}::zagreb`, { proposals: 'must-survive' });
        const env = makeEnvironment({ fake, id: 'failed-snapshot-write-id' });
        fake.failWrite.add(env.workspace.databaseName('zagreb'));
        await env.workspace.ready;
        await expect(env.storage.setScope('zagreb')).rejects.toThrow(`write failed: ${env.workspace.databaseName('zagreb')}`);
        await expect(env.storage.ready).rejects.toThrow(`write failed: ${env.workspace.databaseName('zagreb')}`);
        expect(fake.rows(env.workspace.databaseName('zagreb'))).toEqual({});
    });

    it('does not resurrect a parent snapshot after the child workspace is cleared', async () => {
        const fake = multiDb();
        const city = 'zagreb';
        fake.seed(`${DB_PREFIX}::${city}`, { proposals: 'legacy-seed' });
        const localStorage = memoryStorage();
        const locks = fakeLocks();
        const first = await scoped({ fake, localStorage, locks, id: 'clear-workspace-id' }, city);
        expect(first.storage.getItem('proposals')).toBe('legacy-seed');
        first.storage.clear();
        await new Promise(resolve => setTimeout(resolve, 10));
        first.root.fire('pagehide');
        await Promise.resolve();
        await Promise.resolve();

        const reload = await scoped({ fake, localStorage, locks, id: 'ignored-again' }, city);
        expect(reload.storage.getItem('proposals')).toBeNull();
        expect(fake.rows(reload.workspace.databaseName(city))).toEqual({ [INITIALIZED]: '1' });
    });

    it('leaves storage startup pending without opening IndexedDB when the workspace is blocked', async () => {
        const fake = multiDb();
        const localStorage = memoryStorage();
        const locks = fakeLocks();
        const owner = makeEnvironment({ fake, localStorage, locks, id: 'profile-workspace-id' });
        await owner.workspace.ready;
        const before = Object.fromEntries(localStorage.values);
        const blocked = makeEnvironment({ fake, localStorage, locks, id: 'candidate-workspace-id' });
        await expect(blocked.workspace.ready).resolves.toBe(false);
        const completed = vi.fn();
        blocked.storage.ensureReady(completed);
        const startingOpens = fake.opens.length;
        const pending = blocked.storage.setScope('zagreb');
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(fake.opens).toHaveLength(startingOpens);
        expect(Object.fromEntries(localStorage.values)).toEqual(before);
        expect(completed).not.toHaveBeenCalled();
        let settled = false;
        pending.then(() => { settled = true; }, () => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);
    });

    it('rejects durable mutations after this tab releases workspace ownership', async () => {
        const fake = multiDb();
        const localStorage = memoryStorage();
        const locks = fakeLocks();
        const env = await scoped({ fake, localStorage, locks, id: 'released-owner-id' });
        const writesBefore = fake.writes.length;
        env.root.fire('pagehide');
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(env.workspace.status).toBe('closed');
        await expect(env.storage.atomicWrite({ puts: { proposals: 'stale-tab-write' } }))
            .rejects.toThrow(/workspace/i);
        expect(fake.writes).toHaveLength(writesBefore);
    });
});
