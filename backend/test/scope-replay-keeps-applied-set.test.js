// Re-deriving the ground around an edit replays the designs that already stood there. Only a record
// the edit itself applies may take another design off the map; every other member is put back as it
// was (ProposalManager._rematerializeResolvedScope). One unapplied building used to leave two others
// off the map, because each replayed building parked the proposed buildings on its parcel.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');

const building = (proposalId, applied = true) => ({ proposalId, title: proposalId, goal: 'buildings', applied,
    cadastreParcelIds: ['HR-1'], buildingProposal: { typologyType: 'single' } });
const layout = proposalId => ({ proposalId, title: proposalId, goal: 'parcel-layout', applied: true,
    cadastreParcelIds: ['HR-1'], parcelLayout: { plots: [] } });

// The method under test with every collaborator stubbed: what it asks each replayed record to do.
async function replay(records, seeds, statusMode) {
    const byId = new Map(records.map(record => [record.proposalId, record]));
    const store = { getProposal: id => byId.get(String(id)) || null, getAllProposals: () => records, peekAllProposals: () => records, save: vi.fn(), _indexProposal: vi.fn() };
    const calls = [];
    const manager = {
        _rebuildInProgress: false,
        _localFormationClosure: () => ({ cadastreParcelIds: ['HR-1'], records }),
        _removeProposalOwnedOutput: () => ({ removedParcelIds: [] }),
        _commitRemovedProposalOutput: () => {},
        _appliedCorridorTakes: () => [],
        _deriveCorridorFabric: async () => ({ failed: [], parcels: 1 }),
        _reconcileStructurePresentation: () => {},
        getLastApplyFailureInfo: () => null,
        applyProposal: vi.fn(async (id, options) => { calls.push({ id, keepsAppliedSet: options.preserveAppliedSet === true, replay: options.replay }); return true; })
    };
    const summary = await ProposalManager._rematerializeResolvedScope.call(manager, seeds, { cadastreParcelIds: ['HR-1'] }, {
        statusMode, deferSave: true,
        _parcelMutation: { fabric: {}, proposals: store, afterCommit: () => {} }
    });
    return { summary, calls };
}

describe('scope replay keeps the applied set', () => {
    it('puts every standing design back without letting it take another off the map when one is unapplied', async () => {
        const removed = building('removed', false);
        const standing = [layout('block'), building('first'), building('second')];
        const { summary, calls } = await replay([removed, ...standing], [removed], 'rederive');
        expect(summary.ok).toBe(true);
        // The unapplied design is not replayed; the three that stood are, each as a replay.
        expect(calls.map(call => call.id)).toEqual(['block', 'first', 'second']);
        expect(calls.every(call => call.replay === true)).toBe(true);
        expect(calls.map(call => call.keepsAppliedSet)).toEqual([true, true, true]);
    });

    it('lets only the design being applied choose its ground', async () => {
        const incoming = building('incoming');
        const { calls } = await replay([layout('block'), building('first'), incoming], [incoming], 'apply');
        expect(Object.fromEntries(calls.map(call => [call.id, call.keepsAppliedSet]))).toEqual({ block: true, first: true, incoming: false });
    });
});
