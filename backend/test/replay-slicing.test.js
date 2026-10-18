// The boot replay in slices (proposal-manager.js rebuildAppliedFabric / _rebuildPass): the clock is
// checked after every member, the reset to the cadastre gives the same draft in slices as in one
// go, leaving the city cancels the replay at the next slice and discards its private draft, and the
// deadline is "no progress for N ms", not a total time. Runs through the real ParcelMutation and
// live fabric; ground loading and member applies are stubbed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');
const { createLiveParcelFabric } = require('../../frontend/js/parcels/live-fabric.js');
const { ParcelMutation } = require('../../frontend/js/proposals/apply/transaction.js');
const workSlicer = require('../../frontend/js/work-slicer.js');

const saved = new Map();
function installGlobal(name, value) {
    if (!saved.has(name)) {
        saved.set(name, { existed: Object.prototype.hasOwnProperty.call(globalThis, name), value: globalThis[name] });
    }
    globalThis[name] = value;
}

afterEach(() => {
    for (const [name, prior] of saved) {
        if (prior.existed) globalThis[name] = prior.value;
        else delete globalThis[name];
    }
    saved.clear();
    vi.restoreAllMocks();
});

function box(id, index, properties = {}) {
    const west = 15 + index * 0.001;
    return {
        type: 'Feature',
        properties: { parcelId: id, ...properties },
        geometry: { type: 'Polygon', coordinates: [[[west, 45], [west + 0.001, 45], [west + 0.001, 45.001], [west, 45.001], [west, 45]]] }
    };
}

const building = index => ({
    proposalId: `b-${index}`,
    title: `B${index}`,
    goal: 'buildings',
    applied: true,
    createdAt: `2026-01-01T00:00:${String(index).padStart(2, '0')}Z`,
    cadastreParcelIds: [`HR-${index}`]
});

// Burns real time, so the replay's 8 ms slices fill up as a real member's apply would.
function busy(ms) {
    const until = performance.now() + ms;
    while (performance.now() < until) { /* work */ }
}

async function seededFabric(count) {
    const fabric = createLiveParcelFabric();
    const mutation = fabric.beginMutation({ kind: 'ground-load' });
    mutation.seedCadastre(Array.from({ length: count }, (_, index) => box(`HR-${index}`, index)));
    await mutation.prepare();
    mutation.publish();
    return fabric;
}

function memoryStore(records) {
    return {
        proposals: new Map(records.map(record => [record.proposalId, record])),
        nextProposalId: 1,
        getAllProposals() { return [...this.proposals.values()]; },
        save: vi.fn()
    };
}

// The browser surroundings of a top-level replay: window (an event target), the stores, the fabric.
async function replayWorld(records) {
    const fabric = await seededFabric(records.length);
    const writes = [];
    const win = new EventTarget();
    win.LiveParcelFabric = fabric;
    installGlobal('window', win);
    installGlobal('proposalStorage', memoryStore(records));
    installGlobal('PersistentStorage', {
        getItem: () => null,
        forEach: () => {},
        atomicWrite: async change => { writes.push(change); }
    });
    installGlobal('isProposalCurrentlyApplied', record => record && record.applied === true);
    installGlobal('getProposalKey', record => record.proposalId);
    return { fabric, writes, win };
}

// A manager whose members each cut their own parcel in the draft and take `memberMs` of work.
function replayManager({ memberMs = 3, onMember = null } = {}) {
    const applied = [];
    const manager = {
        ...ProposalManager,
        _lastApplyFailureByProposalId: new Map(),
        _rebuildInProgress: false,
        _loadReplayGround: vi.fn(async () => 0),
        _prefetchDemolitionBuildings: vi.fn(async () => new Map()),
        _resetDerivedFabricSliced: vi.fn(async () => ({ parcels: 0 })),
        _appliedCorridorTakes: vi.fn(() => []),
        _deriveCorridorFabric: vi.fn(async () => ({ parcels: 0, added: 0, removed: 0, unchanged: 0, failed: [] })),
        _reconcileStructurePresentation: vi.fn(),
        applyProposal: vi.fn(async (id, options) => {
            const index = Number(String(id).slice(2));
            options._parcelMutation.fabric.replaceCadastreScope([`HR-${index}`],
                [box(`HR-${index}#b-1`, index, { cadastreParcelIds: [`HR-${index}`], producedByProposalId: id })]);
            busy(memberMs);
            applied.push(id);
            if (onMember) await onMember(applied.length, id);
            return true;
        })
    };
    return { manager, applied };
}

describe('_rebuildPass', () => {
    it('checks the clock after every member, and pauses only when the slice is used up', async () => {
        const records = [0, 1, 2, 3, 4].map(building);
        const slicer = { checkpoint: vi.fn(async () => {}), due: () => false, pause: async () => {} };
        const fabric = await seededFabric(records.length);
        const mutation = fabric.beginMutation({ kind: 'rebuild-applied-fabric' });
        installGlobal('window', {});
        installGlobal('proposalStorage', { save: vi.fn() });
        installGlobal('getProposalKey', record => record.proposalId);
        const { manager } = replayManager();
        await manager._rebuildPass(records, {
            silent: true,
            _parcelMutation: { fabric: mutation, slicer, afterCommit: () => {} }
        });
        expect(manager.applyProposal).toHaveBeenCalledTimes(5);
        expect(slicer.checkpoint).toHaveBeenCalledTimes(5);
        // Each check follows its member's apply, never batched behind several.
        manager.applyProposal.mock.invocationCallOrder.forEach((order, index) => {
            expect(slicer.checkpoint.mock.invocationCallOrder[index]).toBeGreaterThan(order);
        });
        // The steps of the pass get the same slicer.
        expect(manager._resetDerivedFabricSliced.mock.calls[0][2]).toBe(slicer);
        expect(manager._deriveCorridorFabric.mock.calls[0][0].slicer).toBe(slicer);
        expect(manager._loadReplayGround.mock.calls[0][1].slicer).toBe(slicer);
        mutation.rollback();
    });
});

describe('_resetDerivedFabricSliced', () => {
    it('leaves the same draft as the one-shot _resetDerivedFabric', async () => {
        const facts = [0, 1, 2, 3].map(index => box(`HR-${index}`, index, { id: `HR-${index}`, cadastreParcelIds: [`HR-${index}`] }));
        const run = async sliced => {
            const fabric = await seededFabric(4);
            const derive = fabric.beginMutation({ kind: 'apply' });
            derive.replaceCadastreScope(['HR-1'], [
                box('HR-1#p-1', 1, { cadastreParcelIds: ['HR-1'], producedByProposalId: 'p' })
            ]);
            await derive.prepare();
            derive.publish();
            installGlobal('window', {
                LiveParcelFabric: fabric,
                CadastralParcelRepository: {
                    listIds: () => facts.map(fact => fact.properties.parcelId),
                    peekMany: ids => facts.filter(fact => ids.includes(fact.properties.parcelId))
                }
            });
            const mutation = fabric.beginMutation({ kind: 'rebuild-applied-fabric' });
            const options = {
                _parcelMutation: {
                    fabric: mutation,
                    collections: { parks: [], squares: [], lakes: [], transitStations: [], proposedBuildings: [] },
                    afterCommit: () => {}
                }
            };
            const manager = { _clearDerivedRecordState: vi.fn() };
            let t = 0;
            const slicer = workSlicer.createSlicer({ budgetMs: 1, now: () => (t += 1), yieldNow: async () => {} });
            const result = sliced
                ? await ProposalManager._resetDerivedFabricSliced.call(manager, [], options, slicer)
                : ProposalManager._resetDerivedFabric.call(manager, [], options);
            const ids = mutation.snapshot().parcelIds.slice().sort();
            const state = { result, ids, features: ids.map(id => mutation.get(id)), delta: await mutation.prepare() };
            mutation.rollback();
            return { state, pauses: slicer.pauses };
        };
        const oneShot = await run(false);
        const sliced = await run(true);
        expect(oneShot.state.ids).toEqual(['HR-0', 'HR-1', 'HR-2', 'HR-3']);
        expect(sliced.state).toEqual(oneShot.state);
        expect(sliced.pauses).toBeGreaterThan(8);
    });
});

describe('rebuildAppliedFabric', () => {
    it('stops at the next slice when the city is left, and discards its private draft', async () => {
        const records = Array.from({ length: 12 }, (_, index) => building(index));
        const { fabric, writes, win } = await replayWorld(records);
        const before = fabric.snapshot();
        const { manager, applied } = replayManager({
            memberMs: 5,
            onMember: count => { if (count === 3) win.dispatchEvent(new CustomEvent('cityLeaving', { detail: { cityId: 'zagreb' } })); }
        });
        vi.spyOn(console, 'info').mockImplementation(() => {});

        const result = await manager.rebuildAppliedFabric({ silent: true });

        expect(result).toMatchObject({ ok: false, cancelled: true, reason: 'leaving for zagreb' });
        // 5 ms members against 8 ms slices: the replay stopped within a slice of the event.
        expect(applied.length).toBeGreaterThanOrEqual(3);
        expect(applied.length).toBeLessThanOrEqual(5);
        expect(fabric.snapshot()).toEqual(before);
        expect(writes).toHaveLength(0);
        // The queue is free again: the next mutation runs.
        await expect(ParcelMutation.run({ kind: 'after' }, () => 'next', {
            runtime: win, storage: globalThis.PersistentStorage, fabric, proposalStore: null, agentStore: null
        })).resolves.toBe('next');
    });

    it('cancelReplay() stops it the same way', async () => {
        const records = Array.from({ length: 8 }, (_, index) => building(index));
        const { fabric } = await replayWorld(records);
        const before = fabric.snapshot();
        let manager = null;
        ({ manager } = replayManager({ memberMs: 5, onMember: count => { if (count === 2) manager.cancelReplay('superseded by a newer plan'); } }));
        vi.spyOn(console, 'info').mockImplementation(() => {});
        await expect(manager.rebuildAppliedFabric({ silent: true }))
            .resolves.toMatchObject({ ok: false, cancelled: true, reason: 'superseded by a newer plan' });
        expect(fabric.snapshot()).toEqual(before);
        expect(manager.cancelReplay()).toBe(false);
    });

    it('commits a replay that runs far longer than its stall deadline while it keeps making progress', async () => {
        const records = Array.from({ length: 30 }, (_, index) => building(index));
        const { fabric } = await replayWorld(records);
        const { manager } = replayManager({ memberMs: 6 });
        manager.replayStallTimeoutMs = 40;
        const started = performance.now();
        const result = await manager.rebuildAppliedFabric({ silent: true });
        expect(performance.now() - started).toBeGreaterThan(150);
        expect(result).toMatchObject({ ok: true, applied: 30 });
        expect(fabric.snapshot().parcelIds).toContain('HR-29#b-1');
    });

    it('rolls a replay back when it stops making progress', async () => {
        const records = Array.from({ length: 6 }, (_, index) => building(index));
        const { fabric, writes } = await replayWorld(records);
        const before = fabric.snapshot();
        const { manager } = replayManager({
            memberMs: 1,
            onMember: count => (count === 3 ? new Promise(() => {}) : undefined) // a hung ground fetch
        });
        manager.replayStallTimeoutMs = 40;
        vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(manager.rebuildAppliedFabric({ silent: true })).rejects.toMatchObject({ code: 'parcel-mutation-stalled' });
        expect(fabric.snapshot()).toEqual(before);
        expect(writes).toHaveLength(0);
    });
});
