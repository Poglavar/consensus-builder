// A mutation that sets a durable row to the value it already holds writes nothing
// (transaction.js createStorageDraft). A reload's replay re-serializes every record it re-derives;
// unchanged rows must not reach IndexedDB, and a real change still must.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ParcelMutation } = require('../../frontend/js/proposals/apply/transaction.js');

function memoryStorage(initial = {}) {
    const values = new Map(Object.entries(initial));
    const writes = [];
    return {
        writes,
        values,
        getItem: key => values.get(String(key)) ?? null,
        forEach: callback => values.forEach((value, key) => callback(value, key)),
        async atomicWrite(change) {
            writes.push({ puts: new Map(change.puts), deletes: [...change.deletes] });
            change.deletes.forEach(key => values.delete(key));
            change.puts.forEach((value, key) => values.set(key, value));
        }
    };
}

function run(storage, body) {
    return ParcelMutation.run({ kind: 'test' }, body, {
        proposalStore: null, agentStore: null, storage, fabric: null, runtime: {}
    });
}

describe('unchanged durable rows', () => {
    it('opens no write when every row is set to its committed value', async () => {
        const storage = memoryStorage({ 'proposal:p1': '{"a":1}', parcel_X_owner: 'agent_city' });
        await run(storage, async context => {
            context.storage.setItem('proposal:p1', '{"a":1}');
            context.storage.setItem('parcel_X_owner', 'agent_city');
            return true;
        });
        expect(storage.writes).toEqual([]);
    });

    it('writes only the rows that changed', async () => {
        const storage = memoryStorage({ 'proposal:p1': '{"a":1}', 'proposal:p2': '{"b":1}' });
        await run(storage, async context => {
            context.storage.setItem('proposal:p1', '{"a":1}');
            context.storage.setItem('proposal:p2', '{"b":2}');
            context.storage.setItem('proposal:p3', '{"c":1}');
            return true;
        });
        expect(storage.writes).toHaveLength(1);
        expect(Array.from(storage.writes[0].puts.keys()).sort()).toEqual(['proposal:p2', 'proposal:p3']);
    });

    it('a delete followed by setting the committed value back is no change', async () => {
        const storage = memoryStorage({ parcel_X_owner: 'agent_city' });
        await run(storage, async context => {
            context.storage.removeItem('parcel_X_owner');
            context.storage.setItem('parcel_X_owner', 'agent_city');
            return true;
        });
        expect(storage.writes).toEqual([]);
        expect(storage.values.get('parcel_X_owner')).toBe('agent_city');
    });

    it('a change set back to the committed value within the mutation is no change', async () => {
        const storage = memoryStorage({ parcel_X_owner: 'agent_city' });
        await run(storage, async context => {
            context.storage.setItem('parcel_X_owner', 'agent_7');
            expect(context.storage.getItem('parcel_X_owner')).toBe('agent_7');
            context.storage.setItem('parcel_X_owner', 'agent_city');
            return true;
        });
        expect(storage.writes).toEqual([]);
    });
});
