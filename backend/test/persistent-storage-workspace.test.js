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

function makeEnvironment({ fake, localStorage = memoryStorage(), sessionStorage = memoryStorage(), id, locks = fakeLocks() }) {
    const listeners = new Map();
    const root = {
        localStorage, sessionStorage, indexedDB: fake.api, navigator: { locks },
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
        const sessionStorage = memoryStorage();
        const first = await scoped({ fake, localStorage, sessionStorage, id: 'stable-workspace-id' });
        first.storage.setItem('proposals', 'workspace-edit');
        await new Promise(resolve => setTimeout(resolve, 10));
        first.root.fire('pagehide');
        await Promise.resolve();
        await Promise.resolve();

        const reload = await scoped({ fake, localStorage, sessionStorage, id: 'ignored-reload-id' });
        expect(reload.workspace.id).toBe(first.workspace.id);
        expect(reload.storage.getItem('proposals')).toBe('workspace-edit');
        expect(fake.rows(reload.workspace.databaseName('zagreb')).proposals).toBe('workspace-edit');
        expect(fake.writes.filter(write => write.name === reload.workspace.databaseName('zagreb')))
            .toHaveLength(2); // initial snapshot and the explicit edit; reload adds no copy transaction
    });

    it('freezes every saved city at fork boot before later source edits', async () => {
        const fake = multiDb();
        const parent = 'multi-city-parent-id';
        const child = 'multi-city-child-id';
        const zagrebSource = `${DB_PREFIX}::workspace:${parent}::zagreb`;
        const splitSource = `${DB_PREFIX}::workspace:${parent}::split`;
        fake.seed(zagrebSource, { proposals: 'zagreb-at-fork' });
        fake.seed(splitSource, { proposals: 'split-at-fork' });
        const localStorage = memoryStorage({
            [`consensus-builder.workspace:${child}:sources`]: JSON.stringify([parent]),
            [`consensus-builder.workspace:${parent}:sources`]: '[]'
        });
        const sessionStorage = memoryStorage({ [browserWorkspace.SESSION_KEY]: child });
        const first = await scoped({ fake, localStorage, sessionStorage, id: 'unused' }, 'zagreb');
        const childSplit = first.workspace.databaseName('split');
        expect(fake.rows(childSplit)).toMatchObject({ proposals: 'split-at-fork', [INITIALIZED]: '1' });
        expect(fake.rows(first.workspace.databaseName('__workspace'))).toEqual({ [INITIALIZED]: '1' });

        fake.seed(splitSource, { proposals: 'split-edited-after-fork' });
        const laterCity = await scoped({ fake, localStorage, sessionStorage, id: 'ignored-reload-id' }, 'split');
        expect(laterCity.workspace.id).toBe(child);
        expect(laterCity.storage.getItem('proposals')).toBe('split-at-fork');
        expect(fake.rows(childSplit).proposals).toBe('split-at-fork');
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

    it('uses the first initialized ancestor database for an unvisited city, including an intentionally empty one', async () => {
        const fake = multiDb();
        const parent = 'ancestor-workspace-id';
        const child = 'current-workspace-id';
        const localStorage = memoryStorage({
            [`consensus-builder.workspace:${child}:sources`]: JSON.stringify([parent]),
            [`consensus-builder.workspace:${parent}:sources`]: '[]'
        });
        const ancestorCity = `${DB_PREFIX}::workspace:${parent}::split`;
        fake.seed(ancestorCity, { [INITIALIZED]: '1' });
        fake.seed(`${DB_PREFIX}::split`, { proposals: 'legacy-must-not-return' });
        const sessionStorage = memoryStorage({ [browserWorkspace.SESSION_KEY]: child });
        const env = await scoped({ fake, localStorage, sessionStorage, id: 'unused', locks: fakeLocks() }, 'split');

        expect(env.workspace.sourceDatabaseNames('split')).toEqual([ancestorCity, `${DB_PREFIX}::split`]);
        expect(env.storage.length).toBe(0);
        expect(fake.rows(env.workspace.databaseName('split'))).toEqual({ [INITIALIZED]: '1' });
    });

    it('does not resurrect a parent snapshot after the child workspace is cleared', async () => {
        const fake = multiDb();
        const parent = 'parent-clear-id';
        const child = 'child-clear-id';
        const city = 'zagreb';
        const parentDb = `${DB_PREFIX}::workspace:${parent}::${city}`;
        fake.seed(parentDb, { proposals: 'parent-data' });
        const localStorage = memoryStorage({
            [`consensus-builder.workspace:${child}:sources`]: JSON.stringify([parent]),
            [`consensus-builder.workspace:${parent}:sources`]: '[]'
        });
        const sessionStorage = memoryStorage({ [browserWorkspace.SESSION_KEY]: child });
        const first = await scoped({ fake, localStorage, sessionStorage, id: 'ignored' }, city);
        expect(first.storage.getItem('proposals')).toBe('parent-data');
        first.storage.clear();
        await new Promise(resolve => setTimeout(resolve, 10));

        const reload = await scoped({ fake, localStorage, sessionStorage, id: 'ignored-again' }, city);
        expect(reload.storage.getItem('proposals')).toBeNull();
        expect(fake.rows(reload.workspace.databaseName(city))).toEqual({ [INITIALIZED]: '1' });
    });
});
