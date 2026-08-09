import { describe, expect, it } from 'vitest';
import {
    findNonCadastralParentDeclaration,
    serializeProposalRow,
    stripLocalProposalState
} from '../proposals/serializer.js';

describe('proposal API serializer', () => {
    it('removes browser-local applied state from root and nested payloads', () => {
        const value = stripLocalProposalState({
            applied: true,
            appliedAt: 'now',
            status: 'Applied',
            roadProposal: {
                applied: true,
                appliedAt: 'now',
                status: 'applied',
                width: 6,
                definition: { surfaceFootprint: { type: 'Polygon', coordinates: [] } }
            }
        });
        expect(value).toEqual({ roadProposal: { width: 6, definition: {} } });
    });

    it('keeps only roadProposal.definition as corridor geometry', () => {
        const value = stripLocalProposalState({
            definition: { width: 6 },
            geometry: { roadPlan: { width: 6 }, roadGeometry: { polygon: {} } },
            roadProposal: { definition: { width: 6 }, roadGeometry: { polygon: {} } }
        });
        expect(value).toEqual({ roadProposal: { definition: { width: 6 } } });
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

    it('does not heal non-cadastral parent declarations while serializing', () => {
        const record = { parentParcelIds: ['HR-1#c-old-1'] };
        expect(stripLocalProposalState(record).parentParcelIds).toEqual(['HR-1#c-old-1']);
        expect(findNonCadastralParentDeclaration(record)).toEqual({
            path: 'parentParcelIds',
            id: 'HR-1#c-old-1'
        });
    });
});
