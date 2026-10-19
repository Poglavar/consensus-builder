// Locks Pergošićeva A1–A4 to four observed footprints and preserves published
// programme totals only at project level, without inventing per-building allocations.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
    assertReconstructionGeoJSONRoundTrip,
    reconstructionGeoJSONToProposal
} from '../proposals/reconstruction-geojson.js';

const PROPOSAL_PATH = fileURLToPath(new URL(
    '../../rekonstrukcije/pionir-paron/pergosiceva-a1-a4/proposal.geojson',
    import.meta.url
));

async function readProposal() {
    const collection = JSON.parse(await readFile(PROPOSAL_PATH, 'utf8'));
    return { collection, proposal: reconstructionGeoJSONToProposal(collection) };
}

describe('Pergošićeva A1–A4 reconstruction', () => {
    it('contains the four west-to-east current DGU footprints on one parcel', async () => {
        const { proposal } = await readProposal();
        expect(proposal.parentParcelIds).toEqual(['HR-340057-2859/15']);
        expect(proposal.geometry.buildings.map(feature => feature.properties.dguBuildingId)).toEqual([
            13391607,
            13391608,
            13391609,
            13391610
        ]);
        expect(proposal.geometry.buildings.map(feature => feature.properties.positionalLabelBasis))
            .toEqual(Array(4).fill('interni naziv prema položaju od zapada prema istoku; nije oznaka A1–A4 iz dozvole'));
    });

    it('uses reliable 2008 GDI heights without inventing per-building unit counts', async () => {
        const { proposal } = await readProposal();
        const buildings = proposal.geometry.buildings;
        expect(buildings.every(feature => feature.properties.gdiSurveyYear === 2008)).toBe(true);
        expect(buildings.every(feature => feature.properties.gdiMatchOverlapRatio >= 0.95)).toBe(true);
        expect(buildings.every(feature => feature.properties.apartmentCount == null)).toBe(true);
        expect(proposal.source.sourceStatistics.publishedProjectTotals).toMatchObject({
            apartments: 189,
            commercialUnits: 31,
            garages: 86
        });
    });

    it('round-trips exactly four editable building footprints', async () => {
        const { collection, proposal } = await readProposal();
        expect(collection.features.filter(feature => feature.properties?.['consensus:role'] === 'building')).toHaveLength(4);
        expect(assertReconstructionGeoJSONRoundTrip(proposal).buildingCount).toBe(4);
    });
});
