// A fabric rebuild is a replay, not a simultaneous re-apply. Before the first member runs,
// every target record must be locally unapplied; after each member succeeds, only that prefix of
// the ordered list may stand. Otherwise the first taker can amend records that have not replayed
// yet, reversing "each cuts what stands" and making a remote edit disturb old ground.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');
const { isApplied, setProposalApplied } = require('../../frontend/js/proposals/status.js');
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

describe('ProposalManager._rebuildPass — ordered standing prefix', () => {
    it('unapplies the whole replay set first, then exposes only successfully replayed predecessors', async () => {
        const proposals = ['a', 'b', 'c'].map((proposalId, index) => ({
            proposalId,
            title: proposalId.toUpperCase(),
            goal: 'road-track',
            applied: true,
            appliedAt: `2026-08-01T00:00:0${index}.000Z`,
            updatedAt: `2026-08-02T00:00:0${index}.000Z`,
            parentParcelIds: []
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
            _loadReplayGround: ProposalManager._loadReplayGround,
            _replayGroundFetched: new Set(),
            // The corridor half of the derivation. These proposals carry no road geometry, so
            // there are no takes and the fabric step is a no-op — the fold is what is under test.
            _appliedCorridorTakes: ProposalManager._appliedCorridorTakes,
            _deriveCorridorFabric: ProposalManager._deriveCorridorFabric,
            _rebuildPass: ProposalManager._rebuildPass
        };

        const result = await manager._rebuildPass(proposals, new Map(), { silent: true });

        expect(result).toEqual({ ok: true, applied: 3, failed: [] });
        expect(stateBeforeEachApply).toEqual([
            [false, false, false],
            [true, false, false],
            [true, true, false]
        ]);
        proposals.forEach(proposal => {
            expect(proposal.applied).toBe(true);
            expect(proposal.appliedAt).toBe(originalStamps.get(proposal.proposalId).appliedAt);
            expect(proposal.updatedAt).toBe(originalStamps.get(proposal.proposalId).updatedAt);
        });
    });

    it('does not turn a standing record off merely because one replay attempt fails', async () => {
        const proposals = [
            { proposalId: 'failed', title: 'Failed', applied: true, appliedAt: 'before-a', parentParcelIds: [] },
            { proposalId: 'later', title: 'Later', applied: true, appliedAt: 'before-b', parentParcelIds: [] }
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
            _loadReplayGround: ProposalManager._loadReplayGround,
            _replayGroundFetched: new Set(),
            // The corridor half of the derivation. These proposals carry no road geometry, so
            // there are no takes and the fabric step is a no-op — the fold is what is under test.
            _appliedCorridorTakes: ProposalManager._appliedCorridorTakes,
            _deriveCorridorFabric: ProposalManager._deriveCorridorFabric,
            _rebuildPass: ProposalManager._rebuildPass
        };

        const result = await manager._rebuildPass(proposals, { silent: true });

        expect(result.failed.map(item => item.proposalId)).toEqual(['failed']);
        expect(beforeLater).toEqual([[false, false]]);
        expect(proposals.map(item => item.applied)).toEqual([true, true]);
        expect(proposals.map(item => item.appliedAt)).toEqual(['before-a', 'before-b']);
    });
});

describe('ProposalManager.reapplyAppliedProposals — reload barrier', () => {
    it('returns the in-flight replay promise so a shared-route reload cannot inspect a half-built fabric', async () => {
        const proposal = {
            proposalId: 'standing-plan',
            applied: true,
            parentParcelIds: []
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
                return { applied: true, goalKey: 'road-track' };
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
                return { applied: true };
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
            // Whatever a half-finished apply put on the map comes off, and the ground it stood on
            // is derived again — no plan-wide reset.
            deriveForNewProposal: vi.fn(async () => null),
            _undoProposalPayload: vi.fn(() => null),
            _deriveGroundUnder: vi.fn(),
            _rematerializeParkedAlternatives: ProposalManager._rematerializeParkedAlternatives,
            _restoreAfterFailedApply: ProposalManager._restoreAfterFailedApply,
            _refreshUIAfterProposalChange: vi.fn(),
            _collectAppliedAlternativesForExplicitApply: ProposalManager._collectAppliedAlternativesForExplicitApply,
            applyProposal: ProposalManager.applyProposal
        };

        await expect(manager.applyProposal(proposal.proposalId)).resolves.toBe(false);
        expect(proposal.applied).toBe(false);
        expect(manager.deriveForNewProposal).toHaveBeenCalledOnce();
        expect(manager._undoProposalPayload).toHaveBeenCalledWith(proposal);
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
            parentParcelIds: []
        };
        const subdivision = {
            proposalId: 'new-subdivision', goal: 'reparcellization', applied: true,
            createdAt: '2026-02-01T00:00:00.000Z',
            geometry: footprint.geometry,
            parentParcelIds: []
        };
        const proposals = [road, subdivision];

        installGlobal('turf', turf);
        installGlobal('window', { CityConfigManager: null, __planOrder: planOrder });
        installGlobal('proposalStorage', { getAllProposals: () => proposals });
        installGlobal('isProposalCurrentlyApplied', proposal => proposal.applied === true);

        const manager = {
            _rebuildInProgress: false,
            _rebuildPass: vi.fn(async ordered => ({ ok: true, applied: ordered.length, failed: [] })),
            rebuildAppliedFabric: ProposalManager.rebuildAppliedFabric
        };

        await manager.rebuildAppliedFabric({ silent: true, _fabricQueue: true });

        expect(manager._rebuildPass).toHaveBeenCalledOnce();
        expect(manager._rebuildPass.mock.calls[0][0].map(p => p.proposalId))
            .toEqual(['old-road', 'new-subdivision']);
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
    it('purges every derived layer/cache/persisted record before replay and keeps the cadastral base', () => {
        const baseLayer = { feature: { properties: { parcelId: 'HR-A' } } };
        const firstDerived = { feature: { properties: { parcelId: 'HR-A#p-road-1' } } };
        const staleDerived = { feature: { properties: { parcelId: 'HR-A#old-token-9' } } };
        const legacyDerived = { feature: { properties: {
            parcelId: 'HR-339270-824_proposal_9',
            ancestorProposal: 'proposal'
        } } };
        const live = new Set([baseLayer, firstDerived, staleDerived, legacyDerived]);
        const byId = new Map([
            ['HR-A', baseLayer],
            ['HR-A#p-road-1', firstDerived],
            ['HR-A#old-token-9', staleDerived],
            ['HR-339270-824_proposal_9', legacyDerived]
        ]);
        const cacheById = new Map(byId);
        const cleared = vi.fn();
        const shown = vi.fn(id => live.add(byId.get(String(id))));

        installGlobal('window', {
            parcelLayerById: byId,
            parcelLayer: { hasLayer: layer => live.has(layer) },
            ParcelsState: { getParcelCache: () => ({ byId: cacheById }) },
            removeParcelLayerById: id => live.delete(byId.get(String(id))),
            showParcelLayerById: shown,
            __formationEdit: null
        });
        installGlobal('clearPersistedParcelRecord', cleared);

        ProposalManager._resetDerivedFabric([]);

        expect(Array.from(byId.keys())).toEqual(['HR-A']);
        expect(Array.from(cacheById.keys())).toEqual(['HR-A']);
        expect(live).toEqual(new Set([baseLayer]));
        expect(cleared.mock.calls.map(call => call[0]).sort()).toEqual([
            'HR-339270-824_proposal_9',
            'HR-A#old-token-9',
            'HR-A#p-road-1'
        ]);
        expect(shown).toHaveBeenCalledWith('HR-A');
    });
});
