import { describe, expect, it } from 'vitest';
import { serializeProposalRow, stripLocalProposalState } from '../proposals/serializer.js';

describe('proposal API serializer', () => {
    it('removes browser-local applied state from root and nested payloads', () => {
        const value = stripLocalProposalState({
            applied: true,
            appliedAt: 'now',
            status: 'Applied',
            roadProposal: { applied: true, appliedAt: 'now', status: 'applied', width: 6 }
        });
        expect(value).toEqual({ roadProposal: { width: 6 } });
    });

    it('uses the effective lifecycle and a single row-over-JSON precedence rule', () => {
        const proposal = serializeProposalRow({
            id: 5,
            proposal_id: 'p-5',
            title: '',
            lifecycle_status: 'active',
            expires_at: new Date('2026-01-01T00:00:00Z'),
            offer: '0',
            proposal_data: { title: 'fallback', applied: true, lifecycleStatus: 'Executed' }
        }, { now: new Date('2026-02-01T00:00:00Z') });

        expect(proposal).toMatchObject({ id: 5, proposalId: 'p-5', title: '', lifecycleStatus: 'Expired', offer: 0 });
        expect(proposal).not.toHaveProperty('applied');
    });
});
