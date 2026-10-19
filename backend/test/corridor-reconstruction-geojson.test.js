import { describe, expect, it } from 'vitest';
import {
    CORRIDOR_RECONSTRUCTION_GEOJSON_SCHEMA,
    assertCorridorReconstructionGeoJSONRoundTrip,
    corridorProposalToReconstructionGeoJSON,
    corridorReconstructionGeoJSONToProposal
} from '../proposals/corridor-reconstruction-geojson.js';

const polygon = (x, properties = {}) => ({
    type: 'Feature',
    properties,
    geometry: {
        type: 'Polygon',
        coordinates: [[[x, 45], [x + 0.002, 45], [x + 0.002, 45.002], [x, 45.002], [x, 45]]]
    }
});

function proposal() {
    const points = [
        [{ lat: 45.0002, lng: 16.0002 }, { lat: 45.0018, lng: 16.0018 }],
        [{ lat: 45.0010, lng: 16.0002 }, { lat: 45.0010, lng: 16.0018 }]
    ];
    return {
        proposalId: 'test-corridor-reconstruction',
        city: 'zagreb',
        title: 'Test circulation',
        type: 'road',
        goal: 'road-track',
        primaryType: 'Road',
        applied: true,
        parentParcelIds: ['HR-1-2/3'],
        bounds: [16, 45, 16.002, 45.002],
        source: { kind: 'test' },
        geometry: polygon(16).geometry,
        roadProposal: {
            parentParcelIds: ['HR-1-2/3'],
            mode: 'import',
            isCorridor: true,
            definition: {
                points,
                segments: points,
                segmentIds: ['osm-1-1', 'osm-2-1'],
                width: 6,
                profile: { strips: [{ type: 'driving', width: 3 }, { type: 'driving', width: 3 }] },
                segmentProfiles: {
                    'osm-2-1': { strips: [{ type: 'driving', width: 2.75 }] }
                },
                polygon: polygon(16).geometry,
                metadata: { source: 'test' }
            }
        }
    };
}

describe('corridor reconstruction GeoJSON', () => {
    it('stores site, editable centrelines and authoritative footprint separately', () => {
        const output = corridorProposalToReconstructionGeoJSON(proposal(), polygon(15.999));
        expect(output.reconstruction.schema).toBe(CORRIDOR_RECONSTRUCTION_GEOJSON_SCHEMA);
        expect(output.features.map(feature => feature.properties['consensus:role']))
            .toEqual(['site', 'corridor-centerline', 'corridor-centerline', 'corridor-footprint']);
    });

    it('restores segment ids and per-segment profiles without restoring applied state', () => {
        const collection = corridorProposalToReconstructionGeoJSON(proposal(), polygon(15.999));
        const { proposal: imported } = corridorReconstructionGeoJSONToProposal(collection);
        expect(imported.applied).toBe(false);
        expect(imported.roadProposal.definition.segmentIds).toEqual(['osm-1-1', 'osm-2-1']);
        expect(imported.roadProposal.definition.segmentProfiles['osm-2-1'].strips[0].width).toBe(2.75);
        expect(imported.roadProposal.definition.points).toHaveLength(2);
    });

    it('survives export/import/export losslessly', () => {
        const result = assertCorridorReconstructionGeoJSONRoundTrip(proposal(), polygon(15.999));
        expect(result.segmentCount).toBe(2);
        expect(result.collection.reconstruction.proposal.source).toEqual({ kind: 'test' });
    });

    it('rejects a corridor archive without a footprint', () => {
        const collection = corridorProposalToReconstructionGeoJSON(proposal(), polygon(15.999));
        collection.features = collection.features.filter(feature => feature.properties['consensus:role'] !== 'corridor-footprint');
        expect(() => corridorReconstructionGeoJSONToProposal(collection)).toThrow('exactly one corridor footprint');
    });
});
