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
        expect(output.features.map(feature => feature.properties['consensus:role']))
            .toEqual(['site', 'building', 'building']);
    });

    it('imports archived geometry without restoring applied runtime state', () => {
        const imported = reconstructionGeoJSONToProposal(proposalToReconstructionGeoJSON(proposal()));
        expect(imported.applied).toBe(false);
        expect(imported.geometry.buildings).toHaveLength(2);
        expect(imported.buildingProposal.buildings[1].properties.name).toBe('B');
        expect(imported.geometry.superParcel.properties).toEqual({ id: 'HR-1-2/3' });
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
