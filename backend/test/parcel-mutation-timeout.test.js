// Parcel-mutation FIFO liveness: a body that never settles is rejected at its deadline, rolled
// back, and cannot commit if it resolves late; the queue moves on. Also locks the foreign-index
// allocator to an indexed per-cadastre read instead of a full fabric clone per key.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ParcelMutation } = require('../../frontend/js/proposals/apply/transaction.js');
const { createLiveParcelFabric } = require('../../frontend/js/parcels/live-fabric.js');
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');

function polygon(id, properties = {}, dx = 0) {
    return {
        type: 'Feature',
        properties: { parcelId: id, ...properties },
        geometry: { type: 'Polygon', coordinates: [[[dx, 0], [dx + 0.001, 0], [dx + 0.001, 0.001], [dx, 0.001], [dx, 0]]] }
    };
}

function memoryStorage() {
    const values = new Map();
    const writes = [];
    return {
        values,
        writes,
        getItem: key => values.get(String(key)) ?? null,
        forEach: callback => values.forEach((value, key) => callback(value, key)),
        async atomicWrite(change) {
            writes.push({ puts: new Map(change.puts), deletes: [...change.deletes] });
            change.puts.forEach((value, key) => values.set(key, value));
        }
    };
}

async function seededFabric(ids = ['HR-A']) {
    const fabric = createLiveParcelFabric();
    const mutation = fabric.beginMutation({ kind: 'seed' });
    mutation.seedCadastre(ids.map((id, index) => polygon(id, {}, index * 0.01)));
    await mutation.prepare();
    mutation.publish();
    return fabric;
}

describe('ParcelMutation deadline', () => {
    it('rejects a never-settling operation, rolls it back, and runs the next one', async () => {
        const fabric = await seededFabric();
        const storage = memoryStorage();
        const runtime = {};
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        let signal = null;

        const hung = ParcelMutation.run({ kind: 'hung-ground' }, context => {
            signal = context.signal;
            context.fabric.replaceCadastreScope(['HR-A'], [polygon('HR-A#p-1', { cadastreParcelIds: ['HR-A'] })]);
            return new Promise(() => {}); // never settles
        }, { runtime, storage, fabric, proposalStore: null, agentStore: null, timeoutMs: 30 });

        const next = ParcelMutation.run({ kind: 'after' }, context => {
            context.storage.setItem('after', 'ran');
            return 'next-ran';
        }, { runtime, storage, fabric, proposalStore: null, agentStore: null, timeoutMs: 1000 });

        await expect(hung).rejects.toMatchObject({ code: 'parcel-mutation-timeout', timeoutMs: 30 });
        expect(signal.aborted).toBe(true);
        // Rolled back: the committed fabric never saw the hung draft, and no mutation stays active.
        expect(fabric.snapshot()).toMatchObject({ revision: 1, parcelIds: ['HR-A'] });
        await expect(next).resolves.toBe('next-ran');
        expect(storage.values.get('after')).toBe('ran');
        expect(errors).toHaveBeenCalledWith(expect.stringMatching(/\[ParcelMutation\].*did not settle within 30 ms/), expect.anything());
        errors.mockRestore();
    });

    it('ignores a timed-out operation that resolves late', async () => {
        const fabric = await seededFabric();
        const storage = memoryStorage();
        const runtime = { parks: [] };
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        const afterCommit = vi.fn();
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const lateErrors = [];

        const late = ParcelMutation.run({ kind: 'late' }, async context => {
            await gate;
            context.storage.setItem('late', 'written');
            context.collections.parks.push({ id: 'late' });
            try { context.afterCommit(afterCommit); } catch (error) { lateErrors.push(error.code); }
            try {
                context.fabric.replaceCadastreScope(['HR-A'], [polygon('HR-A#late', { cadastreParcelIds: ['HR-A'] })]);
            } catch (error) { lateErrors.push(error.code); }
            return 'late-result';
        }, { runtime, storage, fabric, proposalStore: null, agentStore: null, timeoutMs: 20 });

        await expect(late).rejects.toMatchObject({ code: 'parcel-mutation-timeout' });
        release();
        // Let the late body run to completion.
        await gate;
        await new Promise(resolve => setImmediate(resolve));

        expect(lateErrors).toEqual(['parcel-mutation-timeout', 'live-fabric-mutation-inactive']);
        expect(afterCommit).not.toHaveBeenCalled();
        expect(storage.writes).toHaveLength(0);
        expect(storage.values.has('late')).toBe(false);
        expect(runtime.parks).toEqual([]);
        expect(fabric.snapshot()).toMatchObject({ revision: 1, parcelIds: ['HR-A'] });

        // The queue is healthy afterwards and a fresh mutation commits normally.
        await expect(ParcelMutation.run({ kind: 'fresh' }, context => {
            context.fabric.replaceCadastreScope(['HR-A'], [polygon('HR-A#p-1', { cadastreParcelIds: ['HR-A'] })]);
            return true;
        }, { runtime, storage, fabric, proposalStore: null, agentStore: null })).resolves.toBe(true);
        expect(fabric.snapshot()).toMatchObject({ revision: 2, parcelIds: ['HR-A#p-1'] });
        errors.mockRestore();
    });

    it('does not fire the deadline for an operation that settles in time', async () => {
        const fabric = await seededFabric();
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(ParcelMutation.run({ kind: 'quick' }, async () => 'ok',
            { runtime: {}, storage: memoryStorage(), fabric, proposalStore: null, agentStore: null, timeoutMs: 20 }))
            .resolves.toBe('ok');
        await new Promise(resolve => setTimeout(resolve, 40));
        expect(errors).not.toHaveBeenCalled();
        errors.mockRestore();
    });
});

// The pre-fix algorithm, kept verbatim as the oracle: scan every feature of the draft.
function referenceAllocator(fabric) {
    const next = new Map();
    return (cadastreId, token) => {
        const base = String(cadastreId || '').trim();
        const producerToken = String(token || '').trim();
        const key = JSON.stringify([base, producerToken]);
        if (!next.has(key)) {
            let max = 0;
            fabric.list().forEach(feature => {
                const props = feature && feature.properties || {};
                const anchors = Array.isArray(props.cadastreParcelIds) ? props.cadastreParcelIds.map(String) : [];
                const index = Number(props.syntheticIndex);
                if (!anchors.includes(base) || String(props.syntheticToken || '') !== producerToken
                    || !Number.isInteger(index) || index < 1) return;
                if (index > max) max = index;
            });
            next.set(key, max + 1);
        }
        const value = next.get(key);
        next.set(key, value + 1);
        return value;
    };
}

describe('_createForeignIndexAllocator', () => {
    it('matches the full-scan result using the per-cadastre index, never list()', async () => {
        const fabric = await seededFabric(['HR-A', 'HR-B', 'HR-C']);
        const mutation = fabric.beginMutation({ kind: 'test' });
        mutation.upsertFeatures([
            polygon('HR-A#T1-1', { cadastreParcelIds: ['HR-A'], syntheticToken: 'T1', syntheticIndex: 1 }, 0),
            polygon('HR-A#T1-4', { cadastreParcelIds: ['HR-A'], syntheticToken: 'T1', syntheticIndex: 4 }, 0.002),
            polygon('HR-A#T2-2', { cadastreParcelIds: ['HR-A'], syntheticToken: 'T2', syntheticIndex: 2 }, 0.004),
            // A corridor spanning both cadastres still counts (list() included corridors).
            polygon('ROAD#T1-7', { cadastreParcelIds: ['HR-A', 'HR-B'], syntheticToken: 'T1', syntheticIndex: 7, isRoad: true }, 0.01)
        ]);

        const keys = [['HR-A', 'T1'], ['HR-A', 'T1'], ['HR-A', 'T2'], ['HR-B', 'T1'], ['HR-C', 'T1'], ['HR-B', 'T9'], ['HR-A', 'T2']];
        const expected = keys.map(((alloc) => ([base, token]) => alloc(base, token))(referenceAllocator(mutation)));

        const listSpy = vi.fn(mutation.list);
        const byCadastre = vi.fn(mutation.entriesForCadastre);
        const draft = { ...mutation, list: listSpy, entriesForCadastre: byCadastre };
        const allocate = ProposalManager._createForeignIndexAllocator({ _parcelMutation: { fabric: draft } });
        const actual = keys.map(([base, token]) => allocate(base, token));

        expect(actual).toEqual(expected);
        expect(actual).toEqual([8, 9, 3, 8, 1, 1, 4]);
        expect(listSpy).not.toHaveBeenCalled();
        // Once per distinct key, each scoped to one cadastre.
        expect(byCadastre).toHaveBeenCalledTimes(5);
        byCadastre.mock.calls.forEach(([ids]) => expect(ids).toHaveLength(1));
        mutation.rollback();
    });
});
