import { describe, expect, it } from 'vitest';
import { assertReconstructionGeoJSONRoundTrip } from '../proposals/reconstruction-geojson.js';
import { constructRudesProposal } from '../scripts/seed-rudes-zagrebacka-avenija-proposal.mjs';

describe('Zagrebačka avenija–Rudeš reconstruction', () => {
    it('keeps the final 2025 seven-volume state separate from the pending alternative', async () => {
        const { proposal, buildings, underground, pendingPolygon } = await constructRudesProposal();
        expect(buildings).toHaveLength(7);
        expect(buildings.map(feature => feature.properties.name))
            .toEqual(['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7']);
        expect(underground.properties['edozvola:sourceFeatureId'])
            .toBe('eDozvola_building_polygon.357667');
        expect(pendingPolygon.properties.predmet_web_id).toBe('P20251224-1934214-Z11');
        expect(proposal.geometry.buildings).not.toContain(pendingPolygon);
    });

    it('does not invent official labels, floors or permit GBP', async () => {
        const { buildings } = await constructRudesProposal();
        for (const building of buildings) {
            expect(building.properties.officialVolumeLabel).toBeNull();
            expect(building.properties.floors).toBeNull();
            expect(building.properties.heightBasis).toBe('27 m display proxy');
        }
    });

    it('round-trips the seven editable footprints losslessly', async () => {
        const { proposal } = await constructRudesProposal();
        expect(assertReconstructionGeoJSONRoundTrip(proposal).buildingCount).toBe(7);
    });
});
