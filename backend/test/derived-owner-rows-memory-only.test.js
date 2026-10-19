// A derived live piece's owner row (parcel_<id with #>_owner) is rebuilt by every replay, so it is
// kept in the storage cache only (persistent-storage.js isMemoryOnlyKey), and the stored agents
// leave derived ids out of ownedParcels (agents.js agentRowsForStorage). Durable leftovers are not
// loaded and are deleted with the next write.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const storageSource = readFileSync(new URL('../../frontend/js/persistent-storage.js', import.meta.url), 'utf8');
const agentsSource = readFileSync(new URL('../../frontend/js/agents.js', import.meta.url), 'utf8');

const DERIVED = 'parcel_HR-1-2#c2-abc-1_owner';
const CADASTRAL = 'parcel_HR-1-2_owner';

// An IndexedDB holding `rows`, recording every read-write transaction's operations.
function fakeIndexedDb(rows) {
    const writes = [];
    const db = {
        objectStoreNames: { contains: () => true },
        close() {},
        transaction(_name, mode) {
            const operations = [];
            const tx = {
                objectStore() {
                    if (mode === 'readonly') {
                        return {
                            openCursor() {
                                const request = {};
                                const entries = Object.entries(rows);
                                let index = 0;
                                const step = () => setTimeout(() => {
                                    if (index >= entries.length) { request.onsuccess({ target: { result: null } }); return; }
                                    const [key, value] = entries[index++];
                                    request.onsuccess({ target: { result: { value: { key, value }, continue: step } } });
                                }, 0);
                                step();
                                return request;
                            }
                        };
                    }
                    const done = () => { if (!tx.scheduled) { tx.scheduled = true; setTimeout(() => tx.oncomplete?.(), 1); } return {}; };
                    return {
                        put(record) { operations.push(['put', record.key]); return done(); },
                        delete(key) { operations.push(['delete', key]); return done(); },
                        clear() { operations.push(['clear']); return done(); }
                    };
                }
            };
            if (mode === 'readwrite') writes.push(operations);
            return tx;
        }
    };
    return {
        writes,
        api: { open() { const request = {}; setTimeout(() => { request.result = db; request.onsuccess(); }, 0); return request; } }
    };
}

async function storageWith(rows) {
    const fake = fakeIndexedDb(rows);
    const context = {
        console: { ...console, warn: vi.fn(), info: vi.fn() },
        indexedDB: fake.api, localStorage: { setItem: vi.fn() }, location: { reload: vi.fn() },
        Promise, Map, Set, JSON, String, Number, Object, Array, setTimeout, clearTimeout,
        addEventListener() {}, dispatchEvent() {}, CustomEvent: class { constructor(name) { this.name = name; } }
    };
    context.window = context;
    context.self = context;
    vm.runInNewContext(storageSource, context);
    context.PersistentStorage.setScope('testcity', { explicit: true });
    await context.PersistentStorage.ready;
    return { storage: context.PersistentStorage, writes: fake.writes };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));

describe('derived owner rows are memory-only', () => {
    it('does not load a stored derived owner row, and deletes it with the next write', async () => {
        const { storage, writes } = await storageWith({ [DERIVED]: 'agent_city', [CADASTRAL]: 'agent_7' });
        expect(storage.getItem(DERIVED)).toBeNull();
        expect(storage.getItem(CADASTRAL)).toBe('agent_7');

        await storage.atomicWrite({ puts: new Map([[DERIVED, 'agent_city']]), deletes: [] });
        expect(writes).toEqual([[['delete', DERIVED]]]);
        expect(storage.getItem(DERIVED)).toBe('agent_city');
    });

    it('a replay that only sets derived owner rows opens no IndexedDB write', async () => {
        const { storage, writes } = await storageWith({ [CADASTRAL]: 'agent_7' });
        await storage.atomicWrite({ puts: new Map([[DERIVED, 'agent_city'], ['parcel_HR-9#x-1_owner', 'agent_2']]), deletes: [] });
        expect(writes).toEqual([]);
        expect(storage.getItem(DERIVED)).toBe('agent_city');

        await storage.atomicWrite({ puts: new Map([[CADASTRAL, 'agent_8'], [DERIVED, 'agent_9']]), deletes: ['parcel_HR-9#x-1_owner'] });
        expect(writes).toEqual([[['put', CADASTRAL]]]);
        expect(storage.getItem('parcel_HR-9#x-1_owner')).toBeNull();
        expect(storage.getItem(DERIVED)).toBe('agent_9');
    });

    it('setItem and removeItem keep a derived owner row in memory', async () => {
        const { storage, writes } = await storageWith({});
        storage.setItem(DERIVED, 'agent_3');
        storage.removeItem('parcel_HR-5#y-2_owner');
        storage.setItem(CADASTRAL, 'agent_4');
        await settle();
        expect(storage.getItem(DERIVED)).toBe('agent_3');
        expect(writes).toEqual([[['put', CADASTRAL]]]);
    });

    it('classifies keys by the derived piece id only', async () => {
        const { storage } = await storageWith({});
        expect(storage.isMemoryOnlyKey(DERIVED)).toBe(true);
        expect(storage.isMemoryOnlyKey(CADASTRAL)).toBe(false);
        expect(storage.isMemoryOnlyKey('proposal:c2-1#x')).toBe(false);
    });
});

describe('stored agents', () => {
    function agentStorageWith(PersistentStorage) {
        const start = agentsSource.indexOf('function agentRowsForStorage(');
        const literal = agentsSource.indexOf('const agentStorage = {');
        const end = agentsSource.indexOf('\n};\n', literal);
        const code = agentsSource.slice(start, end + 3) + '\n;agentStorage';
        return vm.runInNewContext(code, { PersistentStorage, JSON, Array, Map, Object, String, console });
    }

    it('leave derived piece ids out of ownedParcels, and a derived-only change writes nothing', () => {
        const PersistentStorage = { isDerivedParcelId: id => String(id).includes('#'), setItem: vi.fn(), getItem: () => null };
        const agents = agentStorageWith(PersistentStorage);
        agents.agents.set('agent_city', { name: 'City', ownedParcels: ['HR-1-2', 'HR-1-2#c2-abc-1'] });

        agents.save();
        const saved = JSON.parse(PersistentStorage.setItem.mock.calls[0][1]);
        expect(saved).toEqual([{ id: 'agent_city', name: 'City', ownedParcels: ['HR-1-2'] }]);
        expect(agents.agents.get('agent_city').ownedParcels).toEqual(['HR-1-2', 'HR-1-2#c2-abc-1']);

        const draft = agents.createMutationDraft(agents.snapshotForMutation());
        draft.agents.get('agent_city').ownedParcels.push('HR-1-2#c2-abc-2');
        expect(agents.serializeMutationDraft(draft)).toBeNull();
        draft.agents.get('agent_city').ownedParcels.push('HR-7-1');
        expect(JSON.parse(agents.serializeMutationDraft(draft).value)[0].ownedParcels).toEqual(['HR-1-2', 'HR-7-1']);
    });
});
