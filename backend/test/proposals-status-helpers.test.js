// The canonical two-axis status accessors. getLifecycleStatus reads the marketplace/on-chain axis;
// isApplied reads the map-application axis. Both read canonical fields only; legacy conversion is
// owned by the one-time tessellation migration.
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

    it('does not infer lifecycle from the legacy status field', () => {
        expect(getLifecycleStatus({ status: 'Applied' })).toBe('Active');
        expect(getLifecycleStatus({ status: 'executed' })).toBe('Active');
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

    it('ignores nested and legacy application state', () => {
        const p = { status: 'Active' };
        expect(isApplied(p, { applied: true, status: 'unapplied' })).toBe(false);
        expect(isApplied(p, { applied: false, status: 'applied' })).toBe(false);
    });

    it('makes the root boolean authoritative over stale nested flags', () => {
        expect(isApplied({ applied: true }, { applied: false })).toBe(true);
        expect(isApplied({ applied: false }, { applied: true })).toBe(false);
    });

    it('does not interpret any legacy status as map application', () => {
        expect(isApplied({ status: 'applied' })).toBe(false);
        expect(isApplied({ status: 'executed' })).toBe(false);
        expect(isApplied({ status: 'cancelled', roadProposal: { status: 'applied' } })).toBe(false);
    });
});

describe('proposal status-axis normalisation', () => {
    it('canonicalises current fields without healing legacy state', () => {
        const proposal = {
            status: 'Executed',
            roadProposal: { status: 'applied', applied: true, appliedAt: 'old' }
        };
        normalizeProposalStatusAxes(proposal);
        expect(proposal).toMatchObject({ lifecycleStatus: 'Active', applied: false });
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
