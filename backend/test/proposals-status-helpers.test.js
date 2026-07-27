// The canonical two-axis status accessors. getLifecycleStatus reads the marketplace/on-chain axis;
// isApplied reads the map-application axis. Both must honour the new fields when present and derive
// sanely from the legacy overloaded `status` for rows the split has not upgraded yet.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    getLifecycleStatus,
    canonicalLifecycle,
    isApplied,
    normalizeProposalStatusAxes,
    parkProposalForImport,
    setProposalApplied,
    stripProposalAppliedState
} = require('../../frontend/js/proposals/status.js');

describe('getLifecycleStatus', () => {
    it('prefers the explicit lifecycleStatus field', () => {
        expect(getLifecycleStatus({ lifecycleStatus: 'Executed', status: 'Applied' })).toBe('Executed');
    });

    it('collapses leaked application words in the legacy status to Active', () => {
        expect(getLifecycleStatus({ status: 'Applied' })).toBe('Active');
        expect(getLifecycleStatus({ status: 'applied' })).toBe('Active');
        expect(getLifecycleStatus({ status: 'unapplied' })).toBe('Active');
    });

    it('canonicalises the real lifecycle values from legacy status', () => {
        expect(getLifecycleStatus({ status: 'Active' })).toBe('Active');
        expect(getLifecycleStatus({ status: 'executed' })).toBe('Executed');
        expect(getLifecycleStatus({ status: 'Cancelled' })).toBe('Cancelled');
        expect(getLifecycleStatus({ status: 'expired' })).toBe('Expired');
        expect(getLifecycleStatus({ status: 'draft' })).toBe('draft');
    });

    it('defaults to Active for empty/unknown/missing', () => {
        expect(getLifecycleStatus({})).toBe('Active');
        expect(getLifecycleStatus(null)).toBe('Active');
        expect(canonicalLifecycle('whatever')).toBe('Active');
    });
});

describe('isApplied', () => {
    it('honours the explicit boolean on the proposal', () => {
        expect(isApplied({ applied: true, status: 'unapplied' })).toBe(true);
        expect(isApplied({ applied: false, status: 'applied' })).toBe(false);
    });

    it('uses a nested boolean only as a fallback for an unnormalised legacy row', () => {
        const p = { status: 'Active' };
        expect(isApplied(p, { applied: true, status: 'unapplied' })).toBe(true);
        expect(isApplied(p, { applied: false, status: 'applied' })).toBe(false);
    });

    it('makes the root boolean authoritative over stale nested flags', () => {
        expect(isApplied({ applied: true }, { applied: false })).toBe(true);
        expect(isApplied({ applied: false }, { applied: true })).toBe(false);
    });

    it('legacy fallback: applied/executed status means on-the-map', () => {
        expect(isApplied({ status: 'applied' })).toBe(true);
        expect(isApplied({ status: 'executed' })).toBe(true);
        expect(isApplied({ status: 'Active' }, { status: 'applied' })).toBe(true);
    });

    it('legacy fallback: unapplied / Active is NOT applied — the 474-style stuck road is left to the backfill', () => {
        // Pre-split shape of proposal 474: top-level Active, road sub unapplied, no boolean yet.
        const p474 = { status: 'Active', roadProposal: { status: 'unapplied', definition: { demolishedBuildings: [{ id: '1' }] } } };
        expect(isApplied(p474, p474.roadProposal)).toBe(false);
        // Once the backfill sets the boolean, it is applied.
        p474.applied = true;
        expect(isApplied(p474, p474.roadProposal)).toBe(true);
    });

    it('legacy fallback: superseded or terminated is never applied', () => {
        expect(isApplied({ status: 'applied', supersededByProposalId: 'p-x' })).toBe(false);
        expect(isApplied({ status: 'cancelled', roadProposal: { status: 'applied' } })).toBe(false);
        expect(isApplied({ status: 'expired', roadProposal: { status: 'applied' } })).toBe(false);
    });
});

describe('proposal status-axis normalisation', () => {
    it('migrates legacy state once to a root applied boolean and removes nested copies', () => {
        const proposal = {
            status: 'Executed',
            roadProposal: { status: 'applied', applied: true, appliedAt: 'old' }
        };
        normalizeProposalStatusAxes(proposal);
        expect(proposal).toMatchObject({ lifecycleStatus: 'Executed', applied: true });
        expect(proposal.status).toBeUndefined();
        expect(proposal.roadProposal).not.toHaveProperty('status');
        expect(proposal.roadProposal).not.toHaveProperty('applied');
        expect(proposal.roadProposal).not.toHaveProperty('appliedAt');
    });

    it('sets local visibility only at the root', () => {
        const proposal = { buildingProposal: { applied: false, appliedAt: 'old' } };
        setProposalApplied(proposal, true, { appliedAt: 'now' });
        expect(proposal).toMatchObject({ applied: true, appliedAt: 'now' });
        expect(proposal.buildingProposal).not.toHaveProperty('applied');
        setProposalApplied(proposal, false);
        expect(proposal.applied).toBe(false);
        expect(proposal).not.toHaveProperty('appliedAt');
    });

    it('strips every local visibility field from an outbound clone', () => {
        const proposal = { applied: true, appliedAt: 'now', structureProposal: { applied: true, appliedAt: 'now' } };
        stripProposalAppliedState(proposal);
        expect(proposal).not.toHaveProperty('applied');
        expect(proposal).not.toHaveProperty('appliedAt');
        expect(proposal.structureProposal).not.toHaveProperty('applied');
        expect(proposal.structureProposal).not.toHaveProperty('appliedAt');
    });

    it('parks imports even when their shared lifecycle is Executed', () => {
        const proposal = { lifecycleStatus: 'Executed', applied: true, roadProposal: { applied: true } };
        parkProposalForImport(proposal);
        expect(proposal.lifecycleStatus).toBe('Executed');
        expect(proposal.applied).toBe(false);
        expect(proposal.roadProposal).not.toHaveProperty('applied');
    });
});
