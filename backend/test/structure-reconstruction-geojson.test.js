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
        city: 'zagreb',
        title: 'Test park',
        type: 'structure',
        goal: 'park',
        applied: true,
        parentParcelIds: ['HR-1-2/3'],
        bounds: [16, 45, 16.002, 45.002],
        source: { kind: 'official-plan' },
        geometry: polygon(16).geometry,
        structureProposal: {
            kind: 'park',
            geometry: polygon(16).geometry,
            blockName: 'Z1',
            parentParcelIds: ['HR-1-2/3'],
            referenceOnly: true
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

    it('restores reference-overlay metadata without restoring applied state', () => {
        const collection = structureProposalToReconstructionGeoJSON(proposal(), polygon(15.999));
        const { proposal: imported } = structureReconstructionGeoJSONToProposal(collection);
        expect(imported.applied).toBe(false);
        expect(imported.structureProposal.referenceOnly).toBe(true);
        expect(imported.structureProposal.geometry).toEqual(polygon(16).geometry);
    });

    it('survives export/import/export losslessly', () => {
        const result = assertStructureReconstructionGeoJSONRoundTrip(proposal(), polygon(15.999));
        expect(result.kind).toBe('park');
        expect(result.collection.reconstruction.proposal.source).toEqual({ kind: 'official-plan' });
    });

    it('rejects a structure archive without a footprint', () => {
        const collection = structureProposalToReconstructionGeoJSON(proposal(), polygon(15.999));
        collection.features = collection.features.filter(feature => feature.properties['consensus:role'] !== 'structure-footprint');
        expect(() => structureReconstructionGeoJSONToProposal(collection)).toThrow('exactly one structure footprint');
    });
});
