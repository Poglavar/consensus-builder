// A fabric rebuild is an ordered fold into a private live-fabric transaction. Authored proposal
// status remains stable while disposable parcel output is rebuilt; no UI reader can observe a
// temporary all-unapplied plan or a half-replayed prefix.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');
const { isApplied, setProposalApplied } = require('../../frontend/js/proposals/status.js');
const { createLiveParcelFabric } = require('../../frontend/js/parcels/live-fabric.js');
const planOrder = require('../../frontend/js/proposals/plan-order.js');
const turf = require('@turf/turf');

const saved = new Map();

function installGlobal(name, value) {
    if (!saved.has(name)) {
        saved.set(name, {
            existed: Object.prototype.hasOwnProperty.call(globalThis, name),
            value: globalThis[name]
        });
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

describe('ProposalManager._rebuildPass — stable authored state', () => {
    it('keeps the complete standing set visible while deriving an ordered private draft', async () => {
        const proposals = ['a', 'b', 'c'].map((proposalId, index) => ({
            proposalId,
            title: proposalId.toUpperCase(),
            goal: 'road-track',
            applied: true,
            appliedAt: `2026-08-01T00:00:0${index}.000Z`,
            updatedAt: `2026-08-02T00:00:0${index}.000Z`,
            cadastreParcelIds: []
        }));
        const byId = new Map(proposals.map(proposal => [proposal.proposalId, proposal]));
        const originalStamps = new Map(proposals.map(proposal => [proposal.proposalId, {
            appliedAt: proposal.appliedAt,
            updatedAt: proposal.updatedAt
        }]));

        installGlobal('window', { __formationEdit: null, __planOrder: null });
        installGlobal('proposalStorage', { save: vi.fn() });
        installGlobal('setProposalApplied', setProposalApplied);
        installGlobal('isProposalCurrentlyApplied', proposal => isApplied(proposal));
        installGlobal('getProposalKey', proposal => proposal.proposalId);

        const stateBeforeEachApply = [];
        const manager = {
            _resetDerivedFabric: vi.fn(),
            applyProposal: vi.fn(async proposalId => {
                stateBeforeEachApply.push(proposals.map(proposal => isApplied(proposal)));
                const proposal = byId.get(String(proposalId));
                setProposalApplied(proposal, true);
                proposal.updatedAt = 'replay-must-not-become-an-edit';
                return true;
            }),
            _loadReplayGround: vi.fn(async () => 0),
            _prefetchDemolitionBuildings: vi.fn(async () => new Map()),
            _appliedCorridorTakes: ProposalManager._appliedCorridorTakes,
            _deriveCorridorFabric: vi.fn(async () => ({ added: 0, removed: 0, unchanged: 0, parcels: 0, failed: [] })),
            _rebuildPass: ProposalManager._rebuildPass
        };

        const result = await manager._rebuildPass(proposals, { silent: true });

        expect(result).toEqual({ ok: true, applied: 3, failed: [], invalidated: [] });
        expect(stateBeforeEachApply).toEqual([
            [true, true, true],
            [true, true, true],
            [true, true, true]
        ]);
        proposals.forEach(proposal => {
            expect(proposal.applied).toBe(true);
            expect(proposal.appliedAt).toBe(originalStamps.get(proposal.proposalId).appliedAt);
            expect(proposal.updatedAt).toBe(originalStamps.get(proposal.proposalId).updatedAt);
        });
    });

    it('does not turn a standing record off merely because one replay attempt fails', async () => {
        const proposals = [
            { proposalId: 'failed', title: 'Failed', applied: true, appliedAt: 'before-a', cadastreParcelIds: [] },
            { proposalId: 'later', title: 'Later', applied: true, appliedAt: 'before-b', cadastreParcelIds: [] }
        ];
        const byId = new Map(proposals.map(item => [item.proposalId, item]));
        installGlobal('window', { __formationEdit: null, __planOrder: null });
        installGlobal('proposalStorage', {
            save: vi.fn(),
            getProposal: id => byId.get(String(id))
        });
        installGlobal('setProposalApplied', setProposalApplied);
        installGlobal('getProposalKey', proposal => proposal.proposalId);

        const beforeLater = [];
        const manager = {
            _lastApplyFailureByProposalId: new Map(),
            _resetDerivedFabric: vi.fn(),
            applyProposal: vi.fn(async proposalId => {
                if (proposalId === 'failed') return false;
                beforeLater.push(proposals.map(item => isApplied(item)));
                setProposalApplied(byId.get(proposalId), true);
                return true;
            }),
            _loadReplayGround: vi.fn(async () => 0),
            _prefetchDemolitionBuildings: vi.fn(async () => new Map()),
            _appliedCorridorTakes: ProposalManager._appliedCorridorTakes,
            _deriveCorridorFabric: vi.fn(async () => ({ added: 0, removed: 0, unchanged: 0, parcels: 0, failed: [] })),
            _rebuildPass: ProposalManager._rebuildPass
        };

        const result = await manager._rebuildPass(proposals, { silent: true });

        expect(result.failed.map(item => item.proposalId)).toEqual(['failed']);
        expect(beforeLater).toEqual([[true, true]]);
        expect(proposals.map(item => item.applied)).toEqual([true, true]);
        expect(proposals.map(item => item.appliedAt)).toEqual(['before-a', 'before-b']);
    });
});

describe('coordinated corridor ground', () => {
    it('comes from authored readjustment polygons and flat cadastral anchors, not generated layers', () => {
        const plot = turf.polygon([[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]]);
        const coordinated = {
            proposalId: 'plots',
            goal: 'reparcellization',
            applied: true,
            coordinatedPlanId: 'plan-a',
            cadastreParcelIds: ['HR-A', 'HR-B'],
            reparcellization: { polygons: [{ geometry: plot.geometry }] }
        };
        const unrelated = {
            proposalId: 'other-plots',
            goal: 'reparcellization',
            applied: true,
            coordinatedPlanId: 'plan-b',
            cadastreParcelIds: ['HR-C'],
            reparcellization: { polygons: [{ geometry: plot.geometry }] }
        };

        // Deliberately no parcelLayerById: generated output was purged before this phase.
        installGlobal('window', { __planOrder: planOrder });
        const occupied = ProposalManager._coordinatedReadjustmentGroundByParcel(
            [{ id: 'road', coordinatedPlanId: 'plan-a' }],
            [coordinated, unrelated]
        );

        expect([...occupied.keys()].sort()).toEqual(['HR-A', 'HR-B']);
        expect(occupied.get('HR-A')).toHaveLength(1);
        expect(occupied.get('HR-A')[0]).toEqual({
            type: 'Feature',
            properties: {},
            geometry: plot.geometry
        });
        expect(occupied.has('HR-C')).toBe(false);
    });
});

describe('ProposalManager.reapplyAppliedProposals — reload barrier', () => {
    it('returns the in-flight replay promise so a shared-route reload cannot inspect a half-built fabric', async () => {
        const proposal = {
            proposalId: 'standing-plan',
            applied: true,
            cadastreParcelIds: []
        };
        let releaseReplay;
        const replayGate = new Promise(resolve => { releaseReplay = resolve; });
        const manager = {
            _initialReapplyDone: false,
            _reapplyInFlight: false,
            rebuildAppliedFabric: vi.fn(() => replayGate),
            reapplyAppliedProposals: ProposalManager.reapplyAppliedProposals
        };

        installGlobal('window', { CityConfigManager: null });
        installGlobal('proposalStorage', { getAllProposals: () => [proposal] });

        const first = manager.reapplyAppliedProposals();
        await Promise.resolve();
        expect(manager.rebuildAppliedFabric).toHaveBeenCalledOnce();

        let secondSettled = false;
        const secondReplay = manager.reapplyAppliedProposals();
        expect(secondReplay).toBe(first);
        const second = secondReplay.then(() => { secondSettled = true; });
        await Promise.resolve();

        expect(secondSettled).toBe(false);
        expect(manager._initialReapplyDone).toBe(false);

        releaseReplay({ ok: true, applied: 1, failed: [] });
        await Promise.all([first, second]);

        expect(manager.rebuildAppliedFabric).toHaveBeenCalledOnce();
        expect(manager._initialReapplyDone).toBe(true);
        expect(manager._reapplyInFlight).toBe(false);
    });
});

// These harnesses stand in for `this`, so every collaborator applyProposal reaches for has to be on
// them — adding one to the real object without adding it here is a TypeError, not a skipped step.
// _collectAppliedAlternativesForExplicitApply is borrowed rather than stubbed: with no
// collectAppliedProposalAlternatives global installed it returns [], which is exactly these tests'
// premise (no alternative is standing), and borrowing keeps that premise honest if the guard changes.
// Applying from the proposal list used to run the WHOLE-PLAN rebuild just to materialise one
// record — 13 s on a 112-road plan. It now derives only the ground whose take set changed, exactly
// like a create or an edit. None of these harnesses carries `rebuildAppliedFabric`, so a fallback
// to the whole plan is a TypeError rather than a slow pass.
describe('ProposalManager.applyProposal — canonical external mutation', () => {
    it('only flips the record, then delegates all map work to a queued scoped derivation', async () => {
        const proposal = { proposalId: 'new-road', goal: 'road-track', applied: false };
        const proposals = new Map([[proposal.proposalId, proposal]]);
        const store = {
            proposals,
            beginBatch: vi.fn(),
            endBatch: vi.fn(),
            save: vi.fn(),
            getProposal: id => proposals.get(String(id)),
            _indexProposal: vi.fn()
        };
        installGlobal('proposalStorage', store);
        installGlobal('setProposalApplied', setProposalApplied);
        installGlobal('isProposalCurrentlyApplied', item => isApplied(item));

        const manager = {
            _enqueueFabricChange: ProposalManager._enqueueFabricChange,
            deriveForNewProposal: vi.fn(async (record, options) => {
                expect(record).toBe(proposal);
                // Already inside the queue slot: enqueueing again would wait on itself.
                expect(options._fabricQueue).toBe(true);
                expect(proposal.applied).toBe(true);
                return { ok: true, applied: true, goalKey: 'road-track' };
            }),
            _refreshUIAfterProposalChange: vi.fn(),
            _collectAppliedAlternativesForExplicitApply: ProposalManager._collectAppliedAlternativesForExplicitApply,
            applyProposal: ProposalManager.applyProposal
        };

        await expect(manager.applyProposal(proposal.proposalId)).resolves.toBe(true);
        expect(manager.deriveForNewProposal).toHaveBeenCalledOnce();
        expect(manager._refreshUIAfterProposalChange).toHaveBeenCalledWith(proposal);
    });

    it('serializes two external applies through their complete derivations', async () => {
        const first = { proposalId: 'first', applied: false };
        const second = { proposalId: 'second', applied: false };
        const proposals = new Map([[first.proposalId, first], [second.proposalId, second]]);
        const store = {
            proposals,
            beginBatch() {},
            endBatch() {},
            save() {},
            getProposal: id => proposals.get(String(id)),
            _indexProposal() {}
        };
        installGlobal('proposalStorage', store);
        installGlobal('setProposalApplied', setProposalApplied);
        installGlobal('isProposalCurrentlyApplied', item => isApplied(item));

        let releaseFirst;
        const firstGate = new Promise(resolve => { releaseFirst = resolve; });
        const snapshots = [];
        const manager = {
            _enqueueFabricChange: ProposalManager._enqueueFabricChange,
            deriveForNewProposal: vi.fn(async () => {
                snapshots.push([first.applied, second.applied]);
                if (snapshots.length === 1) await firstGate;
                return { ok: true, applied: true };
            }),
            _refreshUIAfterProposalChange() {},
            _collectAppliedAlternativesForExplicitApply: ProposalManager._collectAppliedAlternativesForExplicitApply,
            applyProposal: ProposalManager.applyProposal
        };

        const firstApply = manager.applyProposal('first');
        await vi.waitFor(() => expect(snapshots).toEqual([[true, false]]));
        const secondApply = manager.applyProposal('second');
        await Promise.resolve();
        expect(second.applied).toBe(false);

        releaseFirst();
        await Promise.all([firstApply, secondApply]);
        expect(snapshots).toEqual([[true, false], [true, true]]);
    });

    it('parks only the newly requested record when its derivation fails, then restores the prior set', async () => {
        const proposal = { proposalId: 'invalid-new-road', applied: false };
        const proposals = new Map([[proposal.proposalId, proposal]]);
        const store = {
            proposals,
            beginBatch() {},
            endBatch() {},
            save: vi.fn(),
            getProposal: id => proposals.get(String(id)),
            _indexProposal: vi.fn()
        };
        installGlobal('proposalStorage', store);
        installGlobal('setProposalApplied', setProposalApplied);
        installGlobal('isProposalCurrentlyApplied', item => isApplied(item));

        const manager = {
            _enqueueFabricChange: ProposalManager._enqueueFabricChange,
            deriveForNewProposal: vi.fn(async () => null),
            _refreshUIAfterProposalChange: vi.fn(),
            _collectAppliedAlternativesForExplicitApply: ProposalManager._collectAppliedAlternativesForExplicitApply,
            applyProposal: ProposalManager.applyProposal
        };

        await expect(manager.applyProposal(proposal.proposalId)).resolves.toBe(false);
        expect(proposal.applied).toBe(false);
        expect(manager.deriveForNewProposal).toHaveBeenCalledOnce();
    });
});

describe('ProposalManager.rebuildAppliedFabric — immutable record precedence', () => {
    it('ignores obsolete in-place edit timestamps', async () => {
        const footprint = turf.polygon([[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]]);
        const road = {
            proposalId: 'old-road', goal: 'road-track', applied: true,
            createdAt: '2026-01-01T00:00:00.000Z',
            localEditAt: '2026-08-06T13:30:00.000Z',
            geometry: footprint.geometry,
            cadastreParcelIds: []
        };
        const subdivision = {
            proposalId: 'new-subdivision', goal: 'reparcellization', applied: true,
            createdAt: '2026-02-01T00:00:00.000Z',
            geometry: footprint.geometry,
            cadastreParcelIds: []
        };
        const proposals = [road, subdivision];

        installGlobal('turf', turf);
        installGlobal('window', { CityConfigManager: null, __planOrder: planOrder });
        installGlobal('proposalStorage', { getAllProposals: () => proposals });
        installGlobal('isProposalCurrentlyApplied', proposal => proposal.applied === true);

        const manager = {
            _rebuildInProgress: false,
            _rebuildPass: vi.fn(async (ordered, options) => {
                expect(options.preserveAppliedSet).toBe(true);
                return { ok: true, applied: ordered.length, failed: [] };
            }),
            rebuildAppliedFabric: ProposalManager.rebuildAppliedFabric
        };

        await manager.rebuildAppliedFabric({ silent: true, _fabricQueue: true });

        expect(manager._rebuildPass).toHaveBeenCalledOnce();
        expect(manager._rebuildPass.mock.calls[0][0].map(p => p.proposalId))
            .toEqual(['old-road', 'new-subdivision']);
    });

    it('materializes one applied-set snapshot exactly once', async () => {
        const proposal = { proposalId: 'standing', goal: 'single', applied: true, cadastreParcelIds: [] };
        installGlobal('window', { CityConfigManager: null, __planOrder: planOrder });
        installGlobal('proposalStorage', { getAllProposals: () => [proposal] });
        installGlobal('isProposalCurrentlyApplied', record => record.applied === true);

        const manager = {
            _rebuildInProgress: false,
            _rebuildPass: vi.fn(async records => {
                expect(records).toEqual([proposal]);
                return { ok: true, applied: 1, failed: [] };
            }),
            rebuildAppliedFabric: ProposalManager.rebuildAppliedFabric
        };

        await manager.rebuildAppliedFabric({ silent: true, _fabricQueue: true });

        expect(manager._rebuildPass).toHaveBeenCalledOnce();
        expect(proposal.applied).toBe(true);
        expect(manager._lastRebuildProfile.passes).toBe(1);
    });

    it('puts an edit last because the edit is a fresh record', () => {
        const source = { proposalId: 'old-road', createdAt: '2026-01-01T00:00:00.000Z' };
        const intervening = { proposalId: 'square', createdAt: '2026-02-01T00:00:00.000Z' };
        const replacement = { proposalId: 'replacement-road', createdAt: '2026-08-06T13:30:00.000Z' };
        expect(planOrder.orderFormations([replacement, source, intervening]).map(p => p.proposalId))
            .toEqual(['old-road', 'square', 'replacement-road']);
    });
});

describe('ProposalManager._resetDerivedFabric — pristine registry', () => {
    it('replaces a closed cadastral scope inside the explicit live-fabric transaction', async () => {
        const polygon = [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]];
        const cadastral = {
            type: 'Feature',
            properties: { parcelId: 'HR-A', id: 'HR-A', cadastreParcelIds: ['HR-A'] },
            geometry: { type: 'Polygon', coordinates: polygon }
        };
        const derived = {
            type: 'Feature',
            properties: {
                parcelId: 'HR-A#proposal-1',
                cadastreParcelIds: ['HR-A'],
                producedByProposalId: 'proposal'
            },
            geometry: { type: 'Polygon', coordinates: polygon }
        };
        const fabric = createLiveParcelFabric();
        await fabric.transact({ id: 'seed-derived' }, transaction => {
            fabric.upsertFeatures([derived], { transaction });
        });
        const transaction = fabric.beginTransaction({ id: 'reset' });
        const repository = {
            list: vi.fn(() => [cadastral]),
            getMany: vi.fn(ids => ids.includes('HR-A') ? [cadastral] : [])
        };
        installGlobal('window', {
            LiveParcelFabric: fabric,
            CadastralParcelRepository: repository
        });
        const manager = {
            _clearDerivedRecordState: ProposalManager._clearDerivedRecordState
        };

        expect(ProposalManager._resetDerivedFabric.call(manager, [], {
            cadastreParcelIds: ['HR-A'],
            _fabricTransaction: transaction
        })).toEqual({ parcels: 1 });

        expect(fabric.get('HR-A#proposal-1', { transaction })).toBeNull();
        expect(fabric.get('HR-A', { transaction })).toEqual(cadastral);
        expect(fabric.get('HR-A')).toBeNull();
        await fabric.commit(transaction);
        expect(fabric.get('HR-A')).toEqual(cadastral);
    });
});
