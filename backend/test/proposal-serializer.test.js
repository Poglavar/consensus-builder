import { describe, expect, it } from 'vitest';
import {
    assertCanonicalProposalRow,
    findLegacyCadastreDeclaration,
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

    it('strips retired land aliases and reports them before serialization', () => {
        const record = { parentParcelIds: ['HR-1#c-old-1'] };
        expect(stripLocalProposalState(record)).not.toHaveProperty('parentParcelIds');
        expect(findLegacyCadastreDeclaration(record)).toEqual({
            path: 'parentParcelIds',
            value: ['HR-1#c-old-1']
        });
    });

    it('distinguishes retired aliases from current cadastral state references', () => {
        expect(findLegacyCadastreDeclaration({
            cadastreParcelIds: ['HR-1'],
            buildingProposal: { blockParcelIds: ['HR-1#piece'] }
        })).toEqual({
            path: 'buildingProposal.blockParcelIds',
            value: ['HR-1#piece']
        });
        expect(findNonCadastralParentDeclaration({
            cadastreParcelIds: ['HR-1'],
            ownershipFlow: [{ parcelId: 'HR-2', destination: 'public' }]
        })).toEqual({
            path: 'ownershipFlow[0].parcelId',
            id: 'HR-2'
        });
    });

    it('rejects full database rows with missing, conflicting, or generated cadastral identity', () => {
        expect(() => assertCanonicalProposalRow({ cadastre_parcel_ids: null }))
            .toThrow(/cadastre_parcel_ids is required/);
        expect(() => assertCanonicalProposalRow({
            cadastre_parcel_ids: ['HR-1'],
            proposal_data: { cadastreParcelIds: ['HR-2'] }
        })).toThrow(/conflicts/);
        expect(() => assertCanonicalProposalRow({
            cadastre_parcel_ids: ['HR-1#piece'],
            proposal_data: { cadastreParcelIds: ['HR-1#piece'] }
        })).toThrow(/generated id/);
    });

    it('serves one clean authored building geometry', () => {
        const feature = {
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: [] },
            properties: { floors: 4, parcelId: 'HR-1#piece', proposalId: 'p-1' }
        };
        const value = stripLocalProposalState({
            geometry: { buildings: [feature] },
            buildingGeometry: feature.geometry,
            buildingProperties: feature.properties,
            buildingProposal: { buildingFeature: feature, buildings: [feature] }
        });
        expect(value.geometry.buildings[0].properties).toEqual({ floors: 4 });
        expect(value).not.toHaveProperty('buildingGeometry');
        expect(value).not.toHaveProperty('buildingProperties');
        expect(value.buildingProposal).not.toHaveProperty('buildingFeature');
        expect(value.buildingProposal).not.toHaveProperty('buildings');
    });
});
