import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ParcelMutation } = require('../../frontend/js/proposals/apply/transaction.js');
const { createLiveParcelFabric } = require('../../frontend/js/parcels/live-fabric.js');

function polygon(id, properties = {}) {
    return {
        type: 'Feature',
        properties: { parcelId: id, ...properties },
        geometry: { type: 'Polygon', coordinates: [[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]] }
    };
}

function recordStore(mapKey, storageKey, entries) {
    const store = {
        [mapKey]: new Map(entries),
        snapshotForMutation() {
            return { records: new Map(Array.from(this[mapKey], ([id, value]) => [id, structuredClone(value)])) };
        },
        createMutationDraft(snapshot) {
            return { [mapKey]: new Map(Array.from(snapshot.records, ([id, value]) => [id, structuredClone(value)])) };
        },
        serializeMutationDraft(draft) {
            return { key: storageKey, value: JSON.stringify(Array.from(draft[mapKey].entries())) };
        },
        publishMutationDraft(draft) {
            this[mapKey] = new Map(Array.from(draft[mapKey], ([id, value]) => [id, structuredClone(value)]));
        },
        restoreMutationSnapshot(snapshot) {
            this[mapKey] = new Map(Array.from(snapshot.records, ([id, value]) => [id, structuredClone(value)]));
        }
    };
    return store;
}

function memoryStorage(seed = {}) {
    const values = new Map(Object.entries(seed));
    const writes = [];
    let fail = null;
    return {
        values,
        writes,
        failNext(error) { fail = error; },
        getItem: key => values.get(String(key)) ?? null,
        forEach: callback => values.forEach((value, key) => callback(value, key)),
        async atomicWrite(change) {
            writes.push({ puts: new Map(change.puts), deletes: [...change.deletes] });
            if (fail) { const error = fail; fail = null; throw error; }
            change.deletes.forEach(key => values.delete(key));
            change.puts.forEach((value, key) => values.set(key, value));
        }
    };
}

async function seededFabric() {
    const fabric = createLiveParcelFabric();
    const mutation = fabric.beginMutation({ kind: 'seed' });
    mutation.seedCadastre([polygon('HR-A')]);
    await mutation.prepare();
    mutation.publish();
    return fabric;
}

describe('ParcelMutation', () => {
    it('keeps every draft private and durably writes all stores in one call before publication', async () => {
        const proposals = recordStore('proposals', 'proposals', [['p', { applied: false }]]);
        const agents = recordStore('agents', 'agents', [['a', { balance: 10 }]]);
        const storage = memoryStorage({ proposals: 'old-p', agents: 'old-a', 'parcel_HR-A_owner': 'old' });
        const fabric = await seededFabric();
        const runtime = { parks: [{ id: 'old' }] };
        let release;
        const gate = new Promise(resolve => { release = resolve; });

        const pending = ParcelMutation.run({ kind: 'apply', proposalId: 'p' }, async context => {
            context.proposals.proposals.get('p').applied = true;
            context.agents.agents.get('a').balance = 5;
            context.storage.setItem('parcel_HR-A_owner', 'a');
            context.collections.parks.push({ id: 'new' });
            context.fabric.replaceCadastreScope(['HR-A'], [polygon('HR-A#p-1', {
                cadastreParcelIds: ['HR-A'], producedByProposalId: 'p'
            })]);
            await gate;
            return 'committed';
        }, { runtime, proposalStore: proposals, agentStore: agents, storage, fabric });

        await new Promise(resolve => setTimeout(resolve, 0));
        expect(proposals.proposals.get('p').applied).toBe(false);
        expect(agents.agents.get('a').balance).toBe(10);
        expect(storage.getItem('parcel_HR-A_owner')).toBe('old');
        expect(runtime.parks).toEqual([{ id: 'old' }]);
        expect(fabric.snapshot()).toMatchObject({ revision: 1, parcelIds: ['HR-A'] });

        release();
        await expect(pending).resolves.toBe('committed');
        expect(storage.writes).toHaveLength(1);
        expect([...storage.writes[0].puts.keys()].sort()).toEqual(['agents', 'parcel_HR-A_owner', 'proposals']);
        expect(proposals.proposals.get('p').applied).toBe(true);
        expect(agents.agents.get('a').balance).toBe(5);
        expect(runtime.parks).toEqual([{ id: 'old' }, { id: 'new' }]);
        expect(fabric.snapshot()).toMatchObject({ revision: 2, parcelIds: ['HR-A#p-1'] });
    });

    it('leaves every authoritative surface unchanged when the atomic write fails', async () => {
        const proposals = recordStore('proposals', 'proposals', [['p', { applied: false }]]);
        const agents = recordStore('agents', 'agents', [['a', { balance: 10 }]]);
        const storage = memoryStorage({ proposals: 'old-p', agents: 'old-a' });
        storage.failNext(new Error('IndexedDB unavailable'));
        const fabric = await seededFabric();
        const runtime = { parks: [] };

        await expect(ParcelMutation.run({ kind: 'apply' }, context => {
            context.proposals.proposals.get('p').applied = true;
            context.agents.agents.get('a').balance = 0;
            context.collections.parks.push({ id: 'draft' });
            context.fabric.replaceCadastreScope(['HR-A'], [polygon('HR-A#p-1', {
                cadastreParcelIds: ['HR-A'], producedByProposalId: 'p'
            })]);
            return true;
        }, { runtime, proposalStore: proposals, agentStore: agents, storage, fabric }))
            .rejects.toThrow('IndexedDB unavailable');

        expect(proposals.proposals.get('p').applied).toBe(false);
        expect(agents.agents.get('a').balance).toBe(10);
        expect(runtime.parks).toEqual([]);
        expect(fabric.snapshot()).toMatchObject({ revision: 1, parcelIds: ['HR-A'], transactionActive: false });
    });

    it('compensates durable state if publication fails and does not roll back after-commit errors', async () => {
        const proposals = recordStore('proposals', 'proposals', [['p', { applied: false }]]);
        const agents = recordStore('agents', 'agents', []);
        const storage = memoryStorage({ proposals: 'old-p', agents: 'old-a' });
        const fabric = await seededFabric();
        fabric.addCommitParticipant({ prepare: value => value, commit: () => { throw new Error('presenter failed'); } });

        await expect(ParcelMutation.run({ kind: 'apply' }, context => {
            context.proposals.proposals.get('p').applied = true;
            context.fabric.replaceCadastreScope(['HR-A'], [polygon('HR-A#p-1', {
                cadastreParcelIds: ['HR-A'], producedByProposalId: 'p'
            })]);
            return true;
        }, { runtime: {}, proposalStore: proposals, agentStore: agents, storage, fabric }))
            .rejects.toThrow('presenter failed');

        expect(storage.writes).toHaveLength(2);
        expect(storage.getItem('proposals')).toBe('old-p');
        expect(storage.getItem('agents')).toBe('old-a');
        expect(proposals.proposals.get('p').applied).toBe(false);
        expect(fabric.snapshot()).toMatchObject({ revision: 1, parcelIds: ['HR-A'] });

        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const plainFabric = await seededFabric();
        await expect(ParcelMutation.run({ kind: 'cosmetic' }, context => {
            context.proposals.proposals.get('p').applied = true;
            context.afterCommit(() => { throw new Error('toast failed'); });
            return true;
        }, { runtime: {}, proposalStore: proposals, agentStore: agents, storage, fabric: plainFabric }))
            .resolves.toBe(true);
        expect(proposals.proposals.get('p').applied).toBe(true);
        expect(consoleSpy).toHaveBeenCalled();
        consoleSpy.mockRestore();
    });
});
