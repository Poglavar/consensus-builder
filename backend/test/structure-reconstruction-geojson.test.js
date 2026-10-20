import { describe, expect, it } from 'vitest';
import {
    STRUCTURE_RECONSTRUCTION_GEOJSON_SCHEMA,
    assertStructureReconstructionGeoJSONRoundTrip,
    structureProposalToReconstructionGeoJSON,
    structureReconstructionGeoJSONToProposal
} from '../proposals/structure-reconstruction-geojson.js';

const polygon = (x, properties = {}) => ({
    type: 'Feature',
    properties,
    geometry: {
        type: 'Polygon',
        coordinates: [[[x, 45], [x + 0.002, 45], [x + 0.002, 45.002], [x, 45.002], [x, 45]]]
    }
});

function proposal() {
    return {
        proposalId: 'test-structure-reconstruction',
        city: 'test-city',
        title: 'Test park',
        type: 'structure',
        goal: 'park',
        applied: true,
        cadastreParcelIds: ['HR-1-2/3'],
        bounds: [16, 45, 16.002, 45.002],
        source: { kind: 'official-plan' },
        geometry: polygon(16).geometry,
        structureProposal: {
            kind: 'park',
            geometry: polygon(16).geometry,
            blockName: 'Z1'
        }
    };
}

describe('structure reconstruction GeoJSON', () => {
    it('stores the site and structure footprint as separate ordinary features', () => {
        const output = structureProposalToReconstructionGeoJSON(proposal(), polygon(15.999));
        expect(output.reconstruction.schema).toBe(STRUCTURE_RECONSTRUCTION_GEOJSON_SCHEMA);
        expect(output.features.map(feature => feature.properties['consensus:role']))
            .toEqual(['site', 'structure-footprint']);
    });

    it('does not restore applied state', () => {
        const collection = structureProposalToReconstructionGeoJSON(proposal(), polygon(15.999));
        const { proposal: imported } = structureReconstructionGeoJSONToProposal(collection);
        expect(imported.applied).toBe(false);
        expect(imported.structureProposal.geometry).toEqual(polygon(16).geometry);
    });

    it.each(['park', 'square', 'lake', 'station'])('round-trips a %s separately from its decision kind', (kind) => {
        const source = proposal();
        source.kind = 'community-vote';
        source.goal = kind;
        source.structureProposal.kind = kind;
        if (kind === 'station') Object.assign(source.structureProposal, {
            stationType: 'elevated', platformHeightM: 12, center: [16.001, 45.001], bearing: 35
        });
        const result = assertStructureReconstructionGeoJSONRoundTrip(source, polygon(15.999));
        expect(result.kind).toBe(kind);
        expect(result.imported.kind).toBe('community-vote');
        expect(result.imported.structureProposal).toEqual(source.structureProposal);
        expect(result.imported.cadastreParcelIds).toEqual(source.cadastreParcelIds);
        expect(result.collection.reconstruction.proposal.source).toEqual({ kind: 'official-plan' });
    });

    it('strips local application, consent and simulated execution claims in both directions', () => {
        const localClaims = {
            appliedAt: '2026-10-19T00:00:00Z', executedAt: '2026-10-19T00:00:00Z',
            localPurchaseSimulation: { outcome: 'purchased' }, serverProposalId: 42,
            acceptedParcelIds: ['HR-1-2/3'], ownerAcceptances: { 'HR-1-2/3': { accepted: true } },
            authorAgentId: 'local-agent-key', proposalDraftId: 'browser-draft-key', proposalDraftRevision: 7,
            lifecycleEvidence: { protocol: 'proposal-lifecycle-evidence/1', state: 'observed', status: 'Executed' },
            agent: { persona: 'unsigned-local-claim' }
        };
        const source = {
            ...proposal(), ...localClaims,
            proposalOrigin: { relation: 'copy', source: { kind: 'local', localProposalId: 'browser-source-key' }, title: 'Source' }
        };
        const collection = structureProposalToReconstructionGeoJSON(source, polygon(15.999));
        for (const key of Object.keys(localClaims)) expect(collection.reconstruction.proposal).not.toHaveProperty(key);
        expect(collection.reconstruction.proposal.proposalOrigin).toEqual({ relation: 'copy', source: null, title: 'Source' });
        Object.assign(collection.reconstruction.proposal, localClaims);
        collection.reconstruction.proposal.proposalOrigin = source.proposalOrigin;
        const { proposal: imported } = structureReconstructionGeoJSONToProposal(collection);
        for (const key of Object.keys(localClaims)) expect(imported).not.toHaveProperty(key);
        expect(imported.proposalOrigin).toEqual({ relation: 'copy', source: null, title: 'Source' });
        expect(imported.applied).toBe(false);
        expect(source.localPurchaseSimulation).toEqual(localClaims.localPurchaseSimulation);
    });

    it('refuses an unsupported structure kind on export and import', () => {
        const source = proposal();
        source.structureProposal.kind = 'owner-deal';
        expect(() => structureProposalToReconstructionGeoJSON(source, polygon(15.999))).toThrow('Structure reconstruction supports');
        const collection = structureProposalToReconstructionGeoJSON(proposal(), polygon(15.999));
        collection.reconstruction.structureProposal.kind = 'owner-deal';
        expect(() => structureReconstructionGeoJSONToProposal(collection)).toThrow('Structure reconstruction supports');
    });

    it('rejects a structure archive without a footprint', () => {
        const collection = structureProposalToReconstructionGeoJSON(proposal(), polygon(15.999));
        collection.features = collection.features.filter(feature => feature.properties['consensus:role'] !== 'structure-footprint');
        expect(() => structureReconstructionGeoJSONToProposal(collection)).toThrow('exactly one structure footprint');
    });
});
