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
        expect(serialized.parcelSet).toMatchObject({ authority: null, jurisdiction: null, parcelSource: null, parcelIds: ['HR-1-1'] });
        expect(serialized.parcelSet).not.toHaveProperty('referenceAt');
        expect(serialized.parcelSet).not.toHaveProperty('geometryHash');
        const withoutFrame = serializeProposalRow({ ...row, cadastre_frame: null });
        expect(withoutFrame.cadastreFrame).toBeNull();
        expect(withoutFrame.parcelSet).toEqual(serialized.parcelSet);
    });

    it('qualifies the serialized parcel set from binding source and never from city or stale labels', () => {
        const row = {
            city: 'zagreb', cadastre_parcel_ids: ['123/4'],
            binding: { source: 'server:catalog-a', parcelSource: { sourceId: 'catalog-a', snapshotId: null } },
            proposal_data: { parcelSet: { jurisdiction: 'croatia', authority: 'operator-guess' } }
        };
        const serialized = serializeProposalRow(row);
        expect(serialized.parcelSet).toMatchObject({
            parcelSource: { sourceId: 'catalog-a', snapshotId: null },
            jurisdiction: null, authority: null
        });
        const otherSource = serializeProposalRow({
            ...row, binding: { ...row.binding, parcelSource: { sourceId: 'catalog-b', snapshotId: null } }
        });
        expect(otherSource.parcelSet.setHash).not.toBe(serialized.parcelSet.setHash);
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

    it('keeps an operational terminal status and exposes its unsupported evidence separately', () => {
        const proposal = serializeProposalRow({ lifecycle_status: 'Cancelled', proposal_data: {
            lifecycleEvidence: { protocol: 'proposal-lifecycle-evidence/1', state: 'observed', status: 'Cancelled',
                observedAt: '2026-10-19T00:00:00.000Z', observations: [{ source: 'chain-state-read' }] }
        } });
        expect(proposal.lifecycleStatus).toBe('Cancelled');
        expect(proposal.lifecycleEvidence).toMatchObject({
            protocol: 'proposal-lifecycle-evidence/1', state: 'unknown', claimedStatus: 'Cancelled'
        });
    });

    it('strips browser lifecycle evidence before an upload or mint payload is stored', () => {
        const local = { proposalId: 'record-a', lifecycleEvidence: {
            protocol: 'proposal-lifecycle-evidence/1', state: 'observed', status: 'Executed',
            observedAt: '2026-10-19T00:00:00.000Z'
        } };
        expect(stripLocalProposalState(local)).not.toHaveProperty('lifecycleEvidence');
        expect(local).toHaveProperty('lifecycleEvidence');
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

    // PARCEL-OPTIONAL.md: a record may stand on ground with no cadastral parcel, but only with its site.
    // Since M2 no goal or kind makes a record an act on parcels (plan-design-agreement.md: site-binding.js
    // lost isParcelAct), so the site alone decides.
    it('accepts an empty declaration only for a record that carries its site', () => {
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
        expect(rejectionOf({ cadastre_parcel_ids: [], proposal_data: { goal: 'ownership-transfer', cadastreParcelIds: [] } }).detail)
            .toMatch(/cadastre_parcel_ids is required/);
        for (const proposalData of [{ goal: 'ownership-transfer', cadastreParcelIds: [], site }, { goal: 'park', kind: 'owner-vote', cadastreParcelIds: [], site }]) {
            const read = serializeProposalRow({ id: 10, proposal_id: 'p-act', type: 'parcel', cadastre_parcel_ids: [], proposal_data: proposalData });
            expect(read.cadastreParcelIds).toEqual([]);
            expect(read.site).toEqual(site);
        }
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

    it('serves an origin by design CID, drops a browser key, and refuses a server-row origin as an older record', () => {
        const cid = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';
        const row = origin => ({ cadastre_parcel_ids: ['HR-1'], proposal_data: { cadastreParcelIds: ['HR-1'], proposalOrigin: origin } });
        expect(serializeProposalRow(row({ relation: 'copy', source: { kind: 'design', cid }, title: 'Source' })).proposalOrigin)
            .toEqual({ relation: 'copy', source: { kind: 'design', cid }, title: 'Source' });
        expect(serializeProposalRow(row({ relation: 'copy', source: { kind: 'local', localProposalId: 'p-1' }, title: 'Source' })).proposalOrigin)
            .toEqual({ relation: 'copy', source: null, title: 'Source' });
        let refusal = null;
        try {
            serializeProposalRow(row({ relation: 'revision', source: { kind: 'publication', apiBase: 'https://api.example', proposalRowId: '17' } }));
        } catch (error) { refusal = error; }
        expect(isInvalidRecordError(refusal)).toBe(true);
        expect(refusal.status).toBe(422);
        expect(refusal.detail).toMatch(/proposalOrigin/);
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
