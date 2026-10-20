import { describe, expect, it } from 'vitest';
import {
    RECONSTRUCTION_GEOJSON_SCHEMA,
    assertReconstructionGeoJSONRoundTrip,
    proposalToReconstructionGeoJSON,
    reconstructionGeoJSONToProposal
} from '../proposals/reconstruction-geojson.js';

const polygon = (x, properties = {}) => ({
    type: 'Feature',
    properties,
    geometry: {
        type: 'Polygon',
        coordinates: [[[x, 45], [x + 0.001, 45], [x + 0.001, 45.001], [x, 45.001], [x, 45]]]
    }
});

const proposal = () => {
    const buildings = [
        polygon(16, { name: 'A', heightM: 18, floors: 6 }),
        polygon(16.002, { name: 'B', heightM: 24, floors: 8 })
    ];
    return {
        proposalId: 'test-reconstruction',
        city: 'zagreb',
        title: 'Test reconstruction',
        goal: 'single',
        lifecycleStatus: 'Active',
        applied: true,
        parentParcelIds: ['HR-1-2/3'],
        bounds: [15.99, 44.99, 16.01, 45.01],
        source: { kind: 'test' },
        geometry: { superParcel: polygon(15.99, { id: 'HR-1-2/3' }), buildings },
        buildingGeometry: buildings[0].geometry,
        buildingProperties: buildings[0].properties,
        buildingProposal: {
            parentParcelIds: ['HR-1-2/3'],
            createdFrom: 'single-building',
            buildingFeature: buildings[0],
            buildings
        }
    };
};

describe('reconstruction GeoJSON', () => {
    it('stores one site and every building as ordinary GeoJSON features', () => {
        const output = proposalToReconstructionGeoJSON(proposal());
        expect(output.reconstruction.schema).toBe(RECONSTRUCTION_GEOJSON_SCHEMA);
        expect(output.reconstruction.geometryInterpretation).toEqual({ role: 'building-reconstruction',
            physicalStatus: 'not-established-by-archive', planningCompliance: 'not-evaluated' });
        expect(output.features.map(feature => feature.properties['consensus:role']))
            .toEqual(['site', 'building', 'building']);
    });

    it('recomputes archive geometry interpretation on export after import', () => {
        const collection = proposalToReconstructionGeoJSON(proposal());
        collection.reconstruction.geometryInterpretation = {
            role: 'approved-construction', physicalStatus: 'completed', planningCompliance: 'verified'
        };

        const imported = reconstructionGeoJSONToProposal(collection);
        const exported = proposalToReconstructionGeoJSON(imported);

        expect(exported.reconstruction.geometryInterpretation).toEqual({
            role: 'building-reconstruction',
            physicalStatus: 'not-established-by-archive',
            planningCompliance: 'not-evaluated'
        });
        expect(exported.features.map(feature => feature.properties['consensus:role']))
            .toEqual(['site', 'building', 'building']);
    });

    it('imports archived geometry without restoring applied runtime state', () => {
        const imported = reconstructionGeoJSONToProposal(proposalToReconstructionGeoJSON(proposal()));
        expect(imported.applied).toBe(false);
        expect(imported.geometry.buildings).toHaveLength(2);
        expect(imported.buildingProposal.buildings[1].properties.name).toBe('B');
        expect(imported.geometry.superParcel.properties).toEqual({ id: 'HR-1-2/3' });
    });

    it('excludes browser, unsigned and source-row state on archive export and import', () => {
        const source = {
            ...proposal(), id: 91, serverProposalId: 91, authorAgentId: 'local-agent-key',
            proposalDraftId: 'browser-draft-key', proposalDraftRevision: 7,
            appliedAt: '2026-10-19T00:00:00.000Z',
            localPurchaseSimulation: { outcome: 'purchased' },
            lifecycleEvidence: { protocol: 'proposal-lifecycle-evidence/1', state: 'observed', status: 'Executed' },
            agent: { persona: 'unsigned-local-claim' },
            proposalOrigin: { relation: 'copy', source: { kind: 'local', localProposalId: 'browser-source-key' }, title: 'Source' }
        };
        const collection = proposalToReconstructionGeoJSON(source);
        const archived = collection.reconstruction.proposal;
        for (const key of ['id', 'serverProposalId', 'authorAgentId', 'proposalDraftId', 'proposalDraftRevision',
            'appliedAt', 'localPurchaseSimulation', 'lifecycleEvidence', 'agent']) {
            expect(archived).not.toHaveProperty(key);
        }
        expect(archived.proposalOrigin).toEqual({ relation: 'copy', source: null, title: 'Source' });

        collection.reconstruction.proposal = { ...archived, ...source };
        const imported = reconstructionGeoJSONToProposal(collection);
        for (const key of ['id', 'serverProposalId', 'authorAgentId', 'proposalDraftId', 'proposalDraftRevision',
            'appliedAt', 'localPurchaseSimulation', 'lifecycleEvidence', 'agent']) {
            expect(imported).not.toHaveProperty(key);
        }
        expect(imported.proposalOrigin).toEqual({ relation: 'copy', source: null, title: 'Source' });
        expect(imported.applied).toBe(false);
    });

    it('survives export/import/export without losing any feature or metadata', () => {
        const result = assertReconstructionGeoJSONRoundTrip(proposal());
        expect(result.buildingCount).toBe(2);
        expect(result.collection.reconstruction.proposal.source).toEqual({ kind: 'test' });
    });

    it('rejects the single-footprint GeoJSON format at the proposal boundary', () => {
        expect(() => reconstructionGeoJSONToProposal(polygon(16))).toThrow('FeatureCollection');
    });
});
