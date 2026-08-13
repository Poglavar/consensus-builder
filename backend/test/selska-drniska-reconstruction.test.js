// Locks the historical Selska–Drniška reconstruction to one parcel, three unique
// above-ground buildings, six documented floors and matched 2008 GDI heights.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
    assertReconstructionGeoJSONRoundTrip,
    reconstructionGeoJSONToProposal
} from '../proposals/reconstruction-geojson.js';
import { mapSelskaBuildings } from '../scripts/seed-selska-drniska-proposal.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('../../rekonstrukcije/pionir-paron/selska-drniska/', import.meta.url));

async function readJson(name) {
    return JSON.parse(await readFile(`${PROJECT_ROOT}${name}`, 'utf8'));
}

function mappingRows(context) {
    return context.features
        .filter(feature => feature.properties?.['context:role'] !== 'site')
        .map(feature => ({
            zgrada_id: feature.properties.dguBuildingId,
            broj_zgrade: feature.properties.dguBuildingNumber,
            naziv_vrste_zgrade: feature.properties.dguBuildingType,
            area_m2: feature.properties.footprintAreaM2,
            geom_hash: feature.properties.dguGeometryHash,
            source_duplicate_count: feature.properties.dguSourceDuplicateCount,
            centroid_y: feature.properties.centroidNorthing,
            gdi_object_id: feature.properties.gdiObjectId,
            gdi_height_m: feature.properties.gdiHeightM,
            gdi_survey_year: feature.properties.gdiSurveyYear,
            gdi_overlap_ratio: feature.properties.gdiMatchOverlapRatio,
            overture_id: feature.properties.overtureId,
            osm_id: feature.properties.osmId,
            osm_height_m: feature.properties.osmDeclaredHeightM,
            osm_floors: feature.properties.osmDeclaredFloors,
            osm_class: feature.properties.osmClass,
            osm_overlap_ratio: feature.properties.osmDguOverlapRatio,
            geometry: feature.geometry
        }));
}

describe('Selska–Drniška reconstruction', () => {
    it('deduplicates the DGU snapshot to the three north-to-south principal buildings', async () => {
        const context = await readJson('observed-context.geojson');
        const buildings = mapSelskaBuildings(mappingRows(context));
        expect(buildings.map(feature => feature.properties.name)).toEqual([
            'Zgrada 1 (sjeverna)',
            'Zgrada 2 (središnja)',
            'Zgrada 3 (južna)'
        ]);
        expect(buildings.map(feature => feature.properties.dguBuildingId)).toEqual([14430817, 14430818, 14430819]);
        expect(new Set(buildings.map(feature => feature.properties.dguGeometryHash)).size).toBe(3);
    });

    it('uses the documented six above-ground floors and measured GDI heights', async () => {
        const context = await readJson('observed-context.geojson');
        const buildings = mapSelskaBuildings(mappingRows(context));
        expect(buildings.every(feature => feature.properties.floors === 6)).toBe(true);
        expect(buildings.every(feature => feature.properties.gdiSurveyYear === 2008)).toBe(true);
        expect(buildings.every(feature => feature.properties.gdiMatchOverlapRatio > 0.95)).toBe(true);
        [23.33, 23.66, 23.75].forEach((height, index) => {
            expect(buildings[index].properties.heightM).toBeCloseTo(height, 2);
        });
    });

    it('round-trips exactly three editable building footprints', async () => {
        const collection = await readJson('proposal.geojson');
        const proposal = reconstructionGeoJSONToProposal(collection);
        expect(proposal.parentParcelIds).toEqual(['HR-339270-5652/1']);
        expect(assertReconstructionGeoJSONRoundTrip(proposal).buildingCount).toBe(3);
    });
});
