// Parcel-mutation FIFO liveness: a body that never settles is rejected at its deadline, rolled
// back, and cannot commit if it resolves late; the queue moves on. A body with a progress deadline
// (the boot replay) is rolled back only when it stops making progress. Also locks the
// foreign-index allocator to an indexed per-cadastre read instead of a full fabric clone per key.
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

// The boot replay's deadline (progressTimeoutMs): no total limit, only "no progress for N ms".
describe('ParcelMutation progress deadline', () => {
    const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

    it('lets a body that keeps reporting progress run well past the deadline and commit', async () => {
        const fabric = await seededFabric();
        const storage = memoryStorage();
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        const result = await ParcelMutation.run({ kind: 'rebuild-applied-fabric' }, async context => {
            context.fabric.replaceCadastreScope(['HR-A'], [polygon('HR-A#p-1', { cadastreParcelIds: ['HR-A'] })]);
            // 12 × 15 ms ≈ 180 ms of work against a 60 ms no-progress deadline.
            for (let i = 0; i < 12; i += 1) { await tick(15); context.progress(); }
            return 'replayed';
        }, { runtime: {}, storage, fabric, proposalStore: null, agentStore: null, progressTimeoutMs: 60, timeoutMs: 30 });
        expect(result).toBe('replayed');
        expect(fabric.snapshot()).toMatchObject({ revision: 2, parcelIds: ['HR-A#p-1'] });
        expect(errors).not.toHaveBeenCalled();
        errors.mockRestore();
    });

    it('rolls back a body that stops making progress, with its own code', async () => {
        const fabric = await seededFabric();
        const storage = memoryStorage();
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        let signal = null;
        const stalled = ParcelMutation.run({ kind: 'rebuild-applied-fabric' }, async context => {
            signal = context.signal;
            context.fabric.replaceCadastreScope(['HR-A'], [polygon('HR-A#p-1', { cadastreParcelIds: ['HR-A'] })]);
            await tick(10); context.progress();
            await tick(10); context.progress();
            return new Promise(() => {}); // a hung ground fetch: no progress from here on
        }, { runtime: {}, storage, fabric, proposalStore: null, agentStore: null, progressTimeoutMs: 40 });
        await expect(stalled).rejects.toMatchObject({ code: 'parcel-mutation-stalled', timeoutMs: 40 });
        expect(signal.aborted).toBe(true);
        expect(fabric.snapshot()).toMatchObject({ revision: 1, parcelIds: ['HR-A'] });
        expect(storage.writes).toHaveLength(0);
        expect(errors).toHaveBeenCalledWith(expect.stringMatching(/made no progress for 40 ms/), expect.anything());
        errors.mockRestore();
    });

    it('hands its slicer to the body and to the fabric prepare', async () => {
        const fabric = await seededFabric();
        const slicer = { due: () => false, pause: async () => {}, cancelled: false };
        const seen = [];
        fabric.addCommitParticipant({ prepare: (_delta, _view, options) => { seen.push(options.slicer); return null; } });
        await ParcelMutation.run({ kind: 'rebuild-applied-fabric' }, context => {
            seen.push(context.slicer);
            context.fabric.replaceCadastreScope(['HR-A'], [polygon('HR-A#p-2', { cadastreParcelIds: ['HR-A'] })]);
            return true;
        }, { runtime: {}, storage: memoryStorage(), fabric, proposalStore: null, agentStore: null, slicer });
        expect(seen).toEqual([slicer, slicer]);
    });

    it('serializes a store with steps in the slicer\'s slices, writing what one go writes', async () => {
        const workSlicer = require('../../frontend/js/work-slicer.js');
        const store = () => ({
            proposals: new Map([['1', { id: 1 }], ['2', { id: 2 }], ['3', { id: 3 }]]),
            *serializeMutationDraftSteps(draft) {
                const entries = [];
                for (const [id, record] of draft.proposals) { entries.push({ key: `proposal:${id}`, value: JSON.stringify(record) }); yield; }
                return entries;
            }
        });
        const run = async slicer => {
            const storage = memoryStorage();
            await ParcelMutation.run({ kind: 'rebuild-applied-fabric' }, () => true, {
                runtime: {}, storage, fabric: null, proposalStore: store(), agentStore: null, ...(slicer ? { slicer } : {})
            });
            return storage.writes;
        };
        let t = 0;
        const slicer = workSlicer.createSlicer({ budgetMs: 1, now: () => (t += 1), yieldNow: async () => {} });
        const oneGo = await run(null);
        expect(oneGo[0].puts.size).toBe(3);
        expect(await run(slicer)).toEqual(oneGo);
        expect(slicer.pauses).toBeGreaterThanOrEqual(3);
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

    it('never hands a split the index a carried piece keeps once its parent is consumed', async () => {
        const fabric = await seededFabric(['HR-A']);
        const mutation = fabric.beginMutation({ kind: 'test' });
        // The parent HR-A#T1-21 is the highest-numbered piece and has already been consumed: the
        // fabric shows only -20. Its largest leftover keeps index 21.
        mutation.upsertFeatures([
            polygon('HR-A#T1-20', { cadastreParcelIds: ['HR-A'], syntheticToken: 'T1', syntheticIndex: 20 }, 0)
        ]);
        const options = { _parcelMutation: { fabric: mutation } };
        const unreserved = ProposalManager._createForeignIndexAllocator(options);
        expect(unreserved('HR-A', 'T1')).toBe(21); // what overwrote the carried piece

        const allocate = ProposalManager._createForeignIndexAllocator(options);
        allocate.reserve('HR-A', 'T1', 21);
        expect([allocate('HR-A', 'T1'), allocate('HR-A', 'T1')]).toEqual([22, 23]);
        // A reserved index below the next free one changes nothing.
        allocate.reserve('HR-A', 'T1', 3);
        expect(allocate('HR-A', 'T1')).toBe(24);
        mutation.rollback();
    });
});
