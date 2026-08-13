// Locks the three archive-resolved historical Pionir sites to their verified
// present-day parcel unions and DGU footprints without inventing phase mappings.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
    assertReconstructionGeoJSONRoundTrip,
    reconstructionGeoJSONToProposal
} from '../proposals/reconstruction-geojson.js';

const PROJECT_ROOT = fileURLToPath(new URL(
    '../../rekonstrukcije/pionir-paron/',
    import.meta.url
));

async function readProposal(key) {
    const collection = JSON.parse(await readFile(`${PROJECT_ROOT}${key}/proposal.geojson`, 'utf8'));
    return { collection, proposal: reconstructionGeoJSONToProposal(collection) };
}

describe('archive-resolved Pionir reconstructions', () => {
    it('represents Špansko C–D as four physical buildings on the two current parcels', async () => {
        const { proposal } = await readProposal('spansko-c-d');
        expect(proposal.parentParcelIds).toEqual([
            'HR-340057-2811/1',
            'HR-340057-2811/3'
        ]);
        expect(proposal.geometry.buildings).toHaveLength(4);
        expect(proposal.geometry.buildings[0].properties.dguBuildingIds).toEqual([13391660, 13391842]);
        expect(proposal.geometry.buildings[0].properties).toMatchObject({ floors: 7, heightM: 21 });
        expect(proposal.source.sourceStatistics.publishedProjectTotals).toMatchObject({
            apartments: 756,
            physicalBuildings: 4
        });
    });

    it('retains all seven Stenjevečki odvojak footprints without guessing phase labels', async () => {
        const { proposal } = await readProposal('spansko-stenjevecki-odvojak');
        expect(proposal.parentParcelIds).toEqual(['HR-340057-2976/1']);
        expect(proposal.geometry.buildings.map(feature => feature.properties.dguBuildingId)).toEqual([
            13392284,
            13392285,
            13392294,
            13392283,
            13392293,
            13392281,
            13392282
        ]);
        expect(proposal.source.officialProjectLabels).toEqual(['N2', 'E', 'N1', 'F1', 'F2', 'N4', 'N3']);
        expect(proposal.geometry.buildings.every(feature => feature.properties.name.startsWith('Zgrada '))).toBe(true);
    });

    it('contains only the archived S–S12 Selska parcel sequence', async () => {
        const { proposal } = await readProposal('selska-bastijanova-viteziceva');
        expect(proposal.parentParcelIds).toEqual([
            'HR-339270-2682/89',
            'HR-339270-2682/91',
            'HR-339270-2682/93',
            'HR-339270-2682/95',
            'HR-339270-2682/97',
            'HR-339270-2682/99',
            'HR-339270-2682/102',
            'HR-339270-2682/104'
        ]);
        expect(proposal.geometry.buildings).toHaveLength(11);
        expect(new Set(proposal.geometry.buildings.flatMap(feature => feature.properties.dguBuildingIds))).toEqual(new Set([
            13499596,
            13499569,
            13499600,
            13499599,
            13499587,
            13499598,
            13499621,
            13499570,
            13499597,
            13499584,
            13499564
        ]));
        expect(proposal.geometry.buildings.find(feature => feature.properties.name.startsWith('S4–S5'))
            ?.properties.officialProjectLabels).toEqual(['S4', 'S5']);
    });

    it('round-trips all three proposal archives losslessly', async () => {
        for (const key of ['spansko-c-d', 'spansko-stenjevecki-odvojak', 'selska-bastijanova-viteziceva']) {
            const { proposal } = await readProposal(key);
            expect(assertReconstructionGeoJSONRoundTrip(proposal).buildingCount)
                .toBe(proposal.geometry.buildings.length);
        }
    });
});
