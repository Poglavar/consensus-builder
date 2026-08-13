import { describe, expect, it } from 'vitest';
import { assertReconstructionGeoJSONRoundTrip } from '../proposals/reconstruction-geojson.js';
import { constructBorongajProposal } from '../scripts/seed-borongaj-proposal.mjs';

describe('Borongajska–Čavićeva reconstruction', () => {
    it('reduces the accepted 2022 source to nine compatible above-ground volumes', async () => {
        const { proposal, buildings } = await constructBorongajProposal();
        expect(buildings.map(feature => feature.properties.name))
            .toEqual(['A1', 'A2', 'B1', 'B2', 'B3', 'B4', 'C1', 'C2', 'C3']);
        expect(buildings).toHaveLength(9);
        expect(proposal.geometry.superParcel.properties.areaM2).toBeCloseTo(33741.52, 0);
        expect(proposal.buildingProposal.takeWholeParcels).toBe(false);
    });

    it('keeps direct and inferred phase labels distinguishable', async () => {
        const { buildings } = await constructBorongajProposal();
        const byName = Object.fromEntries(buildings.map(feature => [feature.properties.name, feature.properties]));
        expect(byName.A1.phaseLabelConfidence).toBe('direct-permit-geometry-match');
        expect(byName.B4.phaseLabelConfidence).toBe('direct-permit-geometry-match');
        expect(byName.C1.phaseLabelConfidence).toBe('signed-permit-data-plus-later-footprint-match');
        expect(byName.C2.phaseLabelConfidence).toBe('inferred');
        expect(byName.C3.phaseLabelConfidence).toBe('inferred');
    });

    it('round-trips the full nine-volume proposal losslessly', async () => {
        const { proposal } = await constructBorongajProposal();
        expect(assertReconstructionGeoJSONRoundTrip(proposal).buildingCount).toBe(9);
    });
});
