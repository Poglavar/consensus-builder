// The canonical two-axis status accessors. getLifecycleStatus reads the marketplace/on-chain axis;
// isApplied reads the map-application axis. Both must honour the new fields when present and derive
// sanely from the legacy overloaded `status` for rows the split has not upgraded yet.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getLifecycleStatus, canonicalLifecycle, isApplied } = require('../../frontend/js/proposals/status.js');

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

    it('honours the explicit boolean on the sub-proposal', () => {
        const p = { status: 'Active' };
        expect(isApplied(p, { applied: true, status: 'unapplied' })).toBe(true);
        expect(isApplied(p, { applied: false, status: 'applied' })).toBe(false);
    });

    it('is applied when either the sub or the proposal boolean is true (OR, mirroring the old gate)', () => {
        expect(isApplied({ applied: true }, { applied: false })).toBe(true);
        expect(isApplied({ applied: false }, { applied: true })).toBe(true);
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
