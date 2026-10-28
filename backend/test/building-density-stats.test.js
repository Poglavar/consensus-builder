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

    it('fills the shared Geometry statistics card the Block, Row and Detached editors render', () => {
        const api = globalThis.BuildingDensityStats;
        const markup = api.cardMarkup('rowhouse');
        expect(markup).toContain('<summary data-i18n-key="densityStats.title"');
        expect(markup).not.toContain('<h3');
        const ids = ['parcel', 'footprint', 'coverage', 'gbp', 'kin'].map(suffix => `rowhouse-density-${suffix}`);
        ids.forEach(id => expect(markup).toContain(`id="${id}"`));

        const elements = new Map([...ids, 'rowhouse-density-hint'].map(id => [id, { textContent: '' }]));
        const doc = { getElementById: id => elements.get(id) || null };
        const format = {
            formatArea: value => `${Math.round(value)} m2`,
            formatPercent: value => `${value.toFixed(1)}%`,
            formatNumber: value => value.toFixed(2)
        };
        const parcel = turf.polygon([[[0, 0], [0.002, 0], [0.002, 0.002], [0, 0.002], [0, 0]]]);
        const house = turf.polygon([[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]], { height: 6 });
        api.refreshCard(doc, 'rowhouse', { parcelFeature: parcel, buildings: [house], turf, floorHeightM: 3 }, { format, hint: 'per storey' });
        expect(elements.get('rowhouse-density-coverage').textContent).toBe('25.0%');
        expect(elements.get('rowhouse-density-kin').textContent).toBe('0.50');
        expect(elements.get('rowhouse-density-hint').textContent).toBe('per storey');

        // No ground to divide by: the ratios show a dash, never a 0 that reads as an empty plot.
        const open = api.cardValues(api.summarizeDensity({ parcelFeature: null, buildings: [house], turf, floorHeightM: 3, preferHeight: true }), format);
        expect(open).toMatchObject({ parcel: '\u2014', coverage: '\u2014', kin: '\u2014' });
        expect(open.footprint).not.toBe('\u2014');
    });
});
