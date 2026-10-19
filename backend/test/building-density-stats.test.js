// Verifies the geometry-derived indicators displayed by the urban-rule and freeform editors.

import * as turf from '@turf/turf';
import { beforeAll, describe, expect, it } from 'vitest';

let summarizeDensity;

beforeAll(async () => {
    await import('../../frontend/js/building-density-stats.js');
    summarizeDensity = globalThis.BuildingDensityStats.summarizeDensity;
});

describe('building density statistics', () => {
    it('derives footprint, coverage, GBP and kin from parcel and building geometry', () => {
        const parcel = turf.polygon([[[0, 0], [0.002, 0], [0.002, 0.002], [0, 0.002], [0, 0]]]);
        const building = turf.polygon([[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]], {
            storeys: 3
        });

        const stats = summarizeDensity({ parcelFeature: parcel, buildings: [building], turf });

        expect(stats.buildingCount).toBe(1);
        expect(stats.siteCoveragePercent).toBeCloseTo(25, 4);
        expect(stats.aboveGroundGbpM2).toBeCloseTo(stats.footprintAreaM2 * 3, 6);
        expect(stats.kin).toBeCloseTo(0.75, 4);
    });

    it('uses live height and the editor floor height when requested', () => {
        const parcel = turf.polygon([[[0, 0], [0.002, 0], [0.002, 0.002], [0, 0.002], [0, 0]]]);
        const building = turf.polygon([[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]], {
            storeys: 99,
            height: 24
        });

        const stats = summarizeDensity({
            parcelFeature: parcel,
            buildings: [building],
            turf,
            floorHeightM: 3,
            preferHeight: true
        });

        expect(stats.aboveGroundGbpM2).toBeCloseTo(stats.summedFootprintAreaM2 * 8, 6);
        expect(stats.kin).toBeCloseTo(2, 4);
    });

    it('counts overlapping footprint only once for site coverage', () => {
        const parcel = turf.polygon([[[0, 0], [0.002, 0], [0.002, 0.002], [0, 0.002], [0, 0]]]);
        const building = turf.polygon([[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]], {
            storeys: 1
        });

        const stats = summarizeDensity({ parcelFeature: parcel, buildings: [building, building], turf });

        expect(stats.siteCoveragePercent).toBeCloseTo(25, 4);
        expect(stats.summedFootprintAreaM2).toBeCloseTo(stats.footprintAreaM2 * 2, 4);
        expect(stats.overlapAreaM2).toBeCloseTo(stats.footprintAreaM2, 4);
    });
});
