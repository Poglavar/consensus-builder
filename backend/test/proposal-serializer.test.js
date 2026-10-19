import { describe, expect, it } from 'vitest';
import {
    assertCanonicalProposalRow,
    findLegacyCadastreDeclaration,
    findNonCadastralParentDeclaration,
    isInvalidRecordError,
    PROPOSAL_RECORD_INVALID,
    PROPOSAL_RECORD_INVALID_MESSAGE,
    serializeProposalRow,
    stripLocalProposalState
} from '../proposals/serializer.js';

function rejectionOf(row) {
    try {
        assertCanonicalProposalRow(row);
    } catch (error) {
        return error;
    }
    throw new Error('expected the row to be rejected');
}

describe('proposal API serializer', () => {
    it('keeps measurement capture metadata in its frame without inventing parcel-source dates or authority', () => {
        const frame = { capturedAt: '2026-09-20T09:00:00Z', geometryHash: 'source-frame-hash' };
        const row = { city: 'city-a', created_at: '2026-09-22T08:00:00Z', cadastre_parcel_ids: ['HR-1-1'],
            cadastre_frame: frame, proposal_data: { parcelSet: { authority: 'stale-guess', referenceAt: 'stale-date' } } };
        const serialized = serializeProposalRow(row);
        expect(serialized.cadastreFrame).toEqual(frame);
        expect(serialized.parcelSet).toMatchObject({ authority: null, jurisdiction: 'city-a', parcelIds: ['HR-1-1'] });
        expect(serialized.parcelSet).not.toHaveProperty('referenceAt');
        expect(serialized.parcelSet).not.toHaveProperty('geometryHash');
        const withoutFrame = serializeProposalRow({ ...row, cadastre_frame: null });
        expect(withoutFrame.cadastreFrame).toBeNull();
        expect(withoutFrame.parcelSet).toEqual(serialized.parcelSet);
    });

    it('omits unsigned consent from both SQL and JSON while preserving authored approval configuration', () => {
        const claims = { acceptedParcelIds: ['parcel-a'], ownerAcceptances: { 'parcel-a': { acceptedOwnerKeys: ['party-a'] } } };
        const row = { accepted_parcel_ids: claims.acceptedParcelIds, owner_acceptances: claims.ownerAcceptances,
            proposal_data: { ...claims, approvalConfig: { schema: 'proposal-approval/v1' } } };
        const before = structuredClone(row);
        for (const projected of [serializeProposalRow(row), stripLocalProposalState(row.proposal_data)]) {
            expect(projected).not.toHaveProperty('acceptedParcelIds');
            expect(projected).not.toHaveProperty('ownerAcceptances');
            expect(projected.approvalConfig).toEqual(row.proposal_data.approvalConfig);
        }
        expect(row).toEqual(before);
    });

    it.each([undefined, null])('does not revive a chain location from JSON when SQL is %s', onchain_data => {
        const row = { onchain_data, proposal_data: {
            onchain: { proposalId: 'stale-a' }, onchainData: { proposalId: 'stale-b' }
        } };
        const before = structuredClone(row);
        const proposal = serializeProposalRow(row);
        expect(proposal.onchain).toBeNull();
        expect(proposal).not.toHaveProperty('onchainData');
        expect(row).toEqual(before);
    });

    it('serves one SQL chain attachment despite conflicting JSON projections', () => {
        const onchain = { chainId: 'solana-devnet', proposalId: 'current-account' };
        const proposal = serializeProposalRow({ onchain_data: onchain, proposal_data: {
            onchain: { proposalId: 'stale-a' }, onchainData: { proposalId: 'stale-b' }
        } });
        expect(proposal.onchain).toEqual(onchain);
        expect(proposal).not.toHaveProperty('onchainData');
    });

    it.each([undefined, null, '', 'pending'])(
        'does not replace unknown stored lifecycle %s from authored JSON or expiry', lifecycle_status => {
            const proposal = serializeProposalRow({
                lifecycle_status, expires_at: '2020-01-01T00:00:00Z',
                proposal_data: { lifecycleStatus: 'Executed' }
            });
            expect(proposal.lifecycleStatus).toBe('Unknown');
        });

    it('preserves an Unknown SQL result despite an apparently Active stored projection', () => {
        expect(serializeProposalRow({ effective_status: 'Unknown', lifecycle_status: 'Active' })
            .lifecycleStatus).toBe('Unknown');
    });

    it.each(['Active', 'Executed', 'Cancelled', 'Expired', 'draft'])(
        'does not serve an unqualified execution timestamp from a stored %s record', lifecycleStatus => {
            const row = { id: 5, proposal_id: 'record-a', lifecycle_status: lifecycleStatus,
                proposal_data: { lifecycleStatus, executedAt: '2026-10-01T10:00:00.000Z' } };
            const before = structuredClone(row);
            const proposal = serializeProposalRow(row);
            expect(proposal.lifecycleStatus).toBe(lifecycleStatus);
            expect(proposal).not.toHaveProperty('executedAt');
            expect(row).toEqual(before);
        });

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

    it('retains the authored free-placement marker and authoritative binding on a published record', () => {
        const proposal = stripLocalProposalState({
            freePlacement: true,
            site: { type: 'MultiPolygon', coordinates: [] },
            binding: { source: 'server:hr-cadastre', coverage: 'none', parcels: [] },
            cadastreParcelIds: []
        });
        expect(proposal).toMatchObject({
            freePlacement: true,
            binding: { source: 'server:hr-cadastre', coverage: 'none', parcels: [] },
            cadastreParcelIds: []
        });
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

    // PARCEL-OPTIONAL.md: a material proposal may stand on ground with no cadastral parcel, but only
    // with its site; an act on parcels never has an empty declaration.
    it('accepts an empty declaration only for a material record that carries its site', () => {
        const site = { type: 'MultiPolygon', coordinates: [[[[15.97, 45.8], [15.971, 45.8], [15.971, 45.801], [15.97, 45.8]]]] };
        const binding = { parcels: [], coverage: 'partial', toleranceM: 0, unsurveyedM2: 9000 };
        const open = serializeProposalRow({
            id: 9, proposal_id: 'p-open', type: 'structure', cadastre_parcel_ids: [], binding,
            proposal_data: { goal: 'park', cadastreParcelIds: [], site, binding }
        });
        expect(open.cadastreParcelIds).toEqual([]);
        expect(open.site).toEqual(site);
        expect(open.binding).toEqual(binding);
        expect(rejectionOf({ cadastre_parcel_ids: [], proposal_data: { goal: 'park', cadastreParcelIds: [] } }).detail)
            .toMatch(/cadastre_parcel_ids is required/);
        expect(rejectionOf({ cadastre_parcel_ids: [], proposal_data: { goal: 'ownership-transfer', cadastreParcelIds: [], site } }).detail)
            .toMatch(/cadastre_parcel_ids is required/);
        expect(rejectionOf({ cadastre_parcel_ids: [], proposal_data: { goal: 'park', kind: 'owner-vote', cadastreParcelIds: [], site } }).detail)
            .toMatch(/cadastre_parcel_ids is required/);
    });

    it('rejects full database rows with missing, conflicting, or generated cadastral identity', () => {
        expect(rejectionOf({ cadastre_parcel_ids: null }).detail)
            .toMatch(/cadastre_parcel_ids is required/);
        expect(rejectionOf({
            cadastre_parcel_ids: ['HR-1'],
            proposal_data: { cadastreParcelIds: ['HR-2'] }
        }).detail).toMatch(/conflicts/);
        expect(rejectionOf({
            cadastre_parcel_ids: ['HR-1#piece'],
            proposal_data: { cadastreParcelIds: ['HR-1#piece'] }
        }).detail).toMatch(/generated id/);
    });

    it('tells a person the record is too old, and keeps the technical reason for the log', () => {
        const error = rejectionOf({
            cadastre_parcel_ids: ['HR-1'],
            proposal_data: { cadastreParcelIds: ['HR-1'], parentParcelIds: ['HR-1'] }
        });
        expect(isInvalidRecordError(error)).toBe(true);
        expect(error.status).toBe(422);
        expect(error.code).toBe(PROPOSAL_RECORD_INVALID);
        expect(error.message).toBe(PROPOSAL_RECORD_INVALID_MESSAGE);
        expect(error.message).not.toMatch(/parentParcelIds|record/i);
        expect(error.detail).toBe('Invalid proposal record: parentParcelIds is a retired parcel declaration.');
    });

    it('never serves the archived legacy provenance of a migrated record', () => {
        const proposal = serializeProposalRow({
            id: 8,
            cadastre_parcel_ids: ['HR-1'],
            proposal_data: {
                cadastreParcelIds: ['HR-1'],
                title: 'Park',
                legacy: { 'legacy-parcel-declarations-v1': { fields: [] } }
            }
        });
        expect(proposal.title).toBe('Park');
        expect(proposal).not.toHaveProperty('legacy');
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
