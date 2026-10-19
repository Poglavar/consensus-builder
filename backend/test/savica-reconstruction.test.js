// Locks the Savica reconstruction to three labelled, built volumes and their documented programmes.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
    assertReconstructionGeoJSONRoundTrip,
    reconstructionGeoJSONToProposal
} from '../proposals/reconstruction-geojson.js';
import { mapBuiltBuildings } from '../scripts/seed-savica-f1-f3-proposal.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('../../rekonstrukcije/pionir-paron/savica-f1-f3/', import.meta.url));

async function readJson(name) {
    return JSON.parse(await readFile(`${PROJECT_ROOT}${name}`, 'utf8'));
}

async function mappedBuildings() {
    const [archive, context, labels] = await Promise.all([
        readJson('proposal.geojson'),
        readJson('observed-context.geojson'),
        readJson('location-permit-amendment-2021.geojson')
    ]);
    const archivedById = Object.fromEntries(archive.features
        .filter(feature => feature.properties?.['consensus:role'] === 'building')
        .map(feature => [feature.properties.dguBuildingId, feature.properties]));
    const principal = context.features
        .filter(feature => feature.properties?.['context:role'] === 'principal-building')
        .map(feature => {
            const archived = archivedById[feature.properties.dguBuildingId];
            return {
                zgrada_id: feature.properties.dguBuildingId,
                broj_zgrade: feature.properties.dguBuildingNumber,
                naziv_vrste_zgrade: feature.properties.dguBuildingType,
                area_m2: feature.properties.footprintAreaM2,
                geometry: feature.geometry,
                osm_id: archived.osmId,
                num_floors: archived.osmFloors,
                overlap_ratio: archived.osmDguOverlapRatio
            };
        });
    const labelledPermits = labels.features.filter(feature => /\bF[123]\b/i.test(feature.properties?.gradjevina_zahvat_dodatno || ''));
    return mapBuiltBuildings(principal, labelledPermits);
}

describe('Savica F1–F3 reconstruction', () => {
    it('maps the labelled permit state to three current DGU footprints', async () => {
        const buildings = await mappedBuildings();
        expect(buildings.map(feature => feature.properties.name)).toEqual(['F1', 'F2', 'F3']);
        expect(buildings.map(feature => feature.properties.dguBuildingId)).toEqual([13086210, 13086209, 13350652]);
        expect(buildings.every(feature => feature.properties.permitToDguOverlapRatio > 0.85)).toBe(true);
    });

    it('preserves the two 70-apartment volumes and office-only F3', async () => {
        const buildings = await mappedBuildings();
        const byName = Object.fromEntries(buildings.map(feature => [feature.properties.name, feature.properties]));
        expect(byName.F1.apartmentCount).toBe(70);
        expect(byName.F2.apartmentCount).toBe(70);
        expect(byName.F3.apartmentCount).toBe(0);
        expect(byName.F3.officeUnitCount).toBe(8);
        expect(Object.values(byName).every(properties => properties.floors === 8)).toBe(true);
    });

    it('round-trips the three editable built footprints losslessly', async () => {
        const collection = await readJson('proposal.geojson');
        const proposal = reconstructionGeoJSONToProposal(collection);
        expect(assertReconstructionGeoJSONRoundTrip(proposal).buildingCount).toBe(3);
    });
});
