// The pure derivers behind the status-split backfill. They decide, for a legacy DB row, what the new
// `applied` boolean and `lifecycle_status` string should be. These are the rules the migration writes.
import { describe, it, expect } from 'vitest';
import { deriveApplied, deriveLifecycle } from '../scripts/split-status-applied.js';

const row = (over = {}) => ({ status: null, road_proposal: null, building_proposal: null, structure_proposal: null, reparcellization: null, proposal_data: {}, ...over });
const roadWithCuts = (status) => row({ status, type: 'road', road_proposal: { status: 'unapplied', definition: { demolishedBuildings: [{ id: '1' }, { id: '2' }] } } });

describe('deriveApplied', () => {
    it('true for the 114 legacy Applied roads', () => {
        expect(deriveApplied(row({ status: 'Applied', type: 'road' }))).toBe(true);
        expect(deriveApplied(row({ status: 'applied' }))).toBe(true);
        expect(deriveApplied(row({ status: 'executed' }))).toBe(true);
    });

    it('true when a sub-proposal status is applied/executed', () => {
        expect(deriveApplied(row({ status: 'Active', road_proposal: { status: 'applied' } }))).toBe(true);
        expect(deriveApplied(row({ status: 'Active', building_proposal: { status: 'executed' } }))).toBe(true);
    });

    it('rescues the 474-style Active road that carries demolitions but reads unapplied', () => {
        expect(deriveApplied(roadWithCuts('Active'))).toBe(true);
    });

    it('false for a plain unapplied road with no demolitions', () => {
        expect(deriveApplied(row({ status: 'unapplied', road_proposal: { status: 'unapplied', definition: { demolishedBuildings: [] } } }))).toBe(false);
        expect(deriveApplied(row({ status: 'Active' }))).toBe(false);
    });

    it('false for a superseded road even if it still carries demolitions', () => {
        const r = roadWithCuts('Active');
        r.proposal_data = { supersededByProposalId: 'p-new' };
        expect(deriveApplied(r)).toBe(false);
    });

    it('false for cancelled/expired regardless of everything else', () => {
        expect(deriveApplied(row({ status: 'cancelled', road_proposal: { status: 'applied' } }))).toBe(false);
        expect(deriveApplied(roadWithCuts('expired'))).toBe(false);
    });

    it('is idempotent — feeding a post-migration lifecycle value back in is stable', () => {
        // After migration status holds a lifecycle word (Active). A road that carried cuts stays applied.
        const migrated = roadWithCuts('Active');
        expect(deriveApplied(migrated)).toBe(true);
    });
});

describe('deriveLifecycle', () => {
    it('never returns an application word', () => {
        for (const s of ['applied', 'unapplied', 'Applied', '']) {
            expect(deriveLifecycle(row({ status: s }))).toBe('Active');
        }
    });

    it('canonicalises the real lifecycle words', () => {
        expect(deriveLifecycle(row({ status: 'Active' }))).toBe('Active');
        expect(deriveLifecycle(row({ status: 'executed' }))).toBe('Executed');
        expect(deriveLifecycle(row({ status: 'Cancelled' }))).toBe('Cancelled');
        expect(deriveLifecycle(row({ status: 'expired' }))).toBe('Expired');
        expect(deriveLifecycle(row({ status: 'draft' }))).toBe('draft');
    });
});
