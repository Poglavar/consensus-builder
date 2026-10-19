import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../frontend/js/persistent-storage.js', import.meta.url), 'utf8');

function fakeIndexedDb() {
    const state = {
        openCalls: 0,
        writeTransactions: [],
        failNextWrite: false,
        failOpen: false,
        db: null
    };
    const db = {
        objectStoreNames: { contains: () => true },
        close: vi.fn(),
        transaction(_name, mode) {
            const operations = [];
            let aborted = false;
            let completionTimer = null;
            const tx = {
                error: null,
                objectStore() {
                    if (mode === 'readonly') {
                        return {
                            openCursor() {
                                const request = {};
                                setTimeout(() => request.onsuccess?.({ target: { result: null } }), 0);
                                return request;
                            }
                        };
                    }
                    const schedule = () => {
                        if (completionTimer) return;
                        completionTimer = setTimeout(() => {
                            if (!aborted) tx.oncomplete?.();
                        }, 5);
                    };
                    const request = kind => key => {
                        operations.push([kind, key]);
                        const result = {};
                        if (state.failNextWrite) {
                            state.failNextWrite = false;
                            setTimeout(() => {
                                result.error = new Error('request failed');
                                result.onerror?.();
                            }, 0);
                        } else schedule();
                        return result;
                    };
                    return {
                        put(record) { return request('put')(record.key); },
                        delete(key) { return request('delete')(key); },
                        clear() { return request('clear')('*'); }
                    };
                },
                abort() {
                    aborted = true;
                    tx.error = tx.error || new Error('aborted');
                    setTimeout(() => tx.onabort?.(), 0);
                }
            };
            if (mode === 'readwrite') state.writeTransactions.push(operations);
            return tx;
        }
    };
    state.db = db;
    state.api = {
        open() {
            state.openCalls += 1;
            const request = {};
            setTimeout(() => {
                if (state.failOpen) {
                    request.error = new Error('open failed');
                    request.onerror?.();
                } else {
                    request.result = db;
                    request.onsuccess?.();
                }
            }, 0);
            return request;
        }
    };
    return state;
}

async function environment(fake) {
    let domReady;
    const context = {
        console: { ...console, warn: vi.fn(), error: vi.fn(), info: vi.fn() },
        indexedDB: fake.api,
        localStorage: { setItem: vi.fn() },
        location: { reload: vi.fn() },
        Promise,
        Map,
        JSON,
        String,
        Number,
        Object,
        Array,
        setTimeout,
        clearTimeout,
        addEventListener(name, callback) { if (name === 'DOMContentLoaded') domReady = callback; }
    };
    context.window = context;
    context.self = context;
    vm.runInNewContext(source, context);
    domReady();
    await context.PersistentStorage.ready;
    return context.PersistentStorage;
}

describe('PersistentStorage.atomicWrite', () => {
    it('uses one transaction and publishes its cache only after transaction completion', async () => {
        const fake = fakeIndexedDb();
        const storage = await environment(fake);
        const pending = storage.atomicWrite({ puts: { proposals: 'new', agents: 'agents' }, deletes: ['old-owner'] });

        expect(storage.getItem('proposals')).toBeNull();
        await pending;
        expect(storage.getItem('proposals')).toBe('new');
        expect(storage.getItem('agents')).toBe('agents');
        expect(fake.writeTransactions).toHaveLength(1);
        expect(fake.writeTransactions[0]).toEqual([
            ['delete', 'old-owner'], ['put', 'proposals'], ['put', 'agents']
        ]);
    });

    it('rejects request failure and leaves the synchronous cache untouched', async () => {
        const fake = fakeIndexedDb();
        const storage = await environment(fake);
        fake.failNextWrite = true;

        await expect(storage.atomicWrite({ puts: { proposals: 'never-visible' }, deletes: [] }))
            .rejects.toThrow('aborted');
        expect(storage.getItem('proposals')).toBeNull();
    });

    it('shares one in-flight open request and rejects open failure', async () => {
        const fake = fakeIndexedDb();
        const storage = await environment(fake);
        fake.db.onversionchange();
        const before = fake.openCalls;
        const first = storage.atomicWrite({ puts: { first: '1' } });
        const second = storage.atomicWrite({ puts: { second: '2' } });
        await Promise.all([first, second]);
        expect(fake.openCalls - before).toBe(1);

        fake.db.onversionchange();
        fake.failOpen = true;
        await expect(storage.atomicWrite({ puts: { third: '3' } })).rejects.toThrow('open failed');
        expect(storage.getItem('third')).toBeNull();
    });
});
