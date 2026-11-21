// Unit tests for frontend/js/proposals/gain.js — the value-gain and value comparison math for the 3D view. This is
// the money number the panel shows, and it had no coverage while welded into three-mode.js.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const { dedupeCoincidentBuildings, computeParcelMetrics, computeGain, computeValueComparison } = require('../../frontend/js/proposals/gain.js');

// A small square building footprint at (lng,lat) with side ~ degrees, as a faces[] mesh entry.
function meshBuilding(lng, lat, zmin, zmax, side = 0.0005) {
    return {
        z_min: zmin, z_max: zmax,
        faces: [{ coordinates: [[[lng, lat], [lng + side, lat], [lng + side, lat + side], [lng, lat + side], [lng, lat]]] }]
    };
}

describe('dedupeCoincidentBuildings', () => {
    it('drops a coincident twin mesh (same footprint + z-extent)', () => {
        const a = meshBuilding(15.9, 45.8, 0, 12);
        const twin = meshBuilding(15.9, 45.8, 0, 12); // same place, same height
        expect(dedupeCoincidentBuildings([a, twin])).toHaveLength(1);
    });

    it('keeps buildings that differ in height or location', () => {
        const a = meshBuilding(15.9, 45.8, 0, 12);
        const taller = meshBuilding(15.9, 45.8, 0, 30);   // >1 m z-diff
        const elsewhere = meshBuilding(15.91, 45.81, 0, 12); // far away
        expect(dedupeCoincidentBuildings([a, taller, elsewhere])).toHaveLength(3);
    });

    it('passes through 0/1-element inputs untouched', () => {
        expect(dedupeCoincidentBuildings([])).toEqual([]);
        const one = [meshBuilding(15.9, 45.8, 0, 12)];
        expect(dedupeCoincidentBuildings(one)).toBe(one);
    });
});

describe('computeParcelMetrics', () => {
    const parcel = turf.polygon([[[15.9, 45.8], [15.902, 45.8], [15.902, 45.802], [15.9, 45.802], [15.9, 45.8]]]);
    const opts = {
        floorHeightM: 3.5,
        turf,
        footprintOf: (bld) => turf.polygon(bld.faces[0].coordinates),
        heightOf: (feat) => Number(feat.properties?.height) || 0
    };

    it('accumulates built volume from footprint ∩ parcel × z-extent', () => {
        const built = [meshBuilding(15.9005, 45.8005, 0, 10)];
        const m = computeParcelMetrics(parcel, built, [], opts);
        expect(m.builtVolume).toBeGreaterThan(0);
        expect(m.proposedVolume).toBe(0);
        expect(m.builtFloorArea).toBeCloseTo(m.builtVolume / 3.5, 6);
    });

    it('accumulates proposed volume from proposed features × their height', () => {
        const proposed = [turf.polygon(
            [[[15.9005, 45.8005], [15.9009, 45.8005], [15.9009, 45.8009], [15.9005, 45.8009], [15.9005, 45.8005]]],
            { height: 20 }
        )];
        const m = computeParcelMetrics(parcel, [], proposed, opts);
        expect(m.proposedVolume).toBeGreaterThan(0);
        expect(m.proposedFloorArea).toBeCloseTo(m.proposedVolume / 3.5, 6);
    });

    it('clips only buildings whose box touches the parcel, with the same totals', () => {
        const near = meshBuilding(15.9005, 45.8005, 0, 10);
        const far = Array.from({ length: 50 }, (_, i) => meshBuilding(15.95 + i * 0.001, 45.85, 0, 10));
        let footprints = 0;
        const counting = { ...opts, footprintOf: (bld) => { footprints += 1; return opts.footprintOf(bld); } };
        const m = computeParcelMetrics(parcel, [near, ...far], [], counting);

        expect(footprints).toBe(1);
        expect(m.builtVolume).toBeCloseTo(computeParcelMetrics(parcel, [near], [], opts).builtVolume, 6);
    });

    it('returns null without a parcel or turf', () => {
        expect(computeParcelMetrics(null, [], [], opts)).toBeNull();
        expect(computeParcelMetrics(parcel, [], [], { ...opts, turf: null })).toBeNull();
    });
});

describe('computeGain', () => {
    it('is (proposed − built) × price when there is proposed massing', () => {
        const g = computeGain({ builtFloorArea: 100, proposedFloorArea: 300, pricePerM2: 4000, currency: 'EUR' });
        expect(g.gain).toBe((300 - 100) * 4000);
        expect(g.hasProposed).toBe(true);
        expect(g.model).toEqual({
            kind: 'modeled-floor-area-value', quantity: 'gross-floor-area', areaUnit: 'm²',
            currency: 'EUR', amountUnit: 'EUR', ratePerM2GrossFloorArea: 4000
        });
    });

    it('counts the gain in the currency its price is in', () => {
        const g = computeGain({ builtFloorArea: 100, proposedFloorArea: 300, pricePerM2: 3000, currency: 'GBP' });
        expect(g.gain).toBe(200 * 3000);
        expect(g.model).toMatchObject({ currency: 'GBP', amountUnit: 'GBP', ratePerM2GrossFloorArea: 3000 });
    });

    it('refuses a price without a currency', () => {
        expect(() => computeGain({ builtFloorArea: 100, proposedFloorArea: 300, pricePerM2: 3000 })).toThrow(/currency/);
    });

    it('reports current value (not a negative delta) when there is no proposed massing', () => {
        const g = computeGain({ builtFloorArea: 100, proposedFloorArea: 0, pricePerM2: 4000, currency: 'EUR' });
        expect(g.hasProposed).toBe(false);
        expect(g.currentValue).toBe(100 * 4000);
        expect(g.avg).toBeNull();
    });

    it('is negative when a proposal reduces floor area (a real loss)', () => {
        const g = computeGain({ builtFloorArea: 300, proposedFloorArea: 100, pricePerM2: 4000, currency: 'EUR' });
        expect(g.gain).toBeLessThan(0);
        expect(g.hasProposed).toBe(true);
    });

    it('computes per-parcel average only with proposed massing and a positive count', () => {
        expect(computeGain({ builtFloorArea: 0, proposedFloorArea: 400, pricePerM2: 1000, currency: 'EUR', parcelCount: 4 }).avg)
            .toBe((400 * 1000) / 4);
        expect(computeGain({ builtFloorArea: 0, proposedFloorArea: 0, pricePerM2: 1000, currency: 'EUR', parcelCount: 4 }).avg)
            .toBeNull();
    });
});

// The 3D panel's Built / Planned / Proposed comparison at a sale price and a construction cost.
describe('computeValueComparison', () => {
    // 200 m² of land at 500 a m², no sale tax unless a test sets one.
    const prices = { salePerM2: 4000, constructionPerM2: 2000, landPerM2: 500, saleTaxShare: 0, landAreaM2: 200, currency: 'GBP' };

    it('values every column and charges new building its all-in cost: construction, land, tax and the built value', () => {
        const c = computeValueComparison({ floorAreas: { built: 100, planned: 400, proposed: 300 }, ...prices });
        expect(c.columns.built).toMatchObject({ available: true, floorArea: 100, value: 400000, totalCost: null, profit: null });
        // 400 m² × 4,000 − (400 m² × 2,000 + 200 m² × 500 + the 400,000 the built floor area is worth)
        expect(c.columns.planned).toMatchObject({ available: true, value: 1600000, constructionCost: 800000, landCost: 100000,
            saleTax: 0, replacedValue: 400000, totalCost: 1300000, profit: 300000 });
        expect(c.columns.proposed).toMatchObject({ available: true, value: 1200000, constructionCost: 600000, totalCost: 1100000, profit: 100000 });
        expect(c.currency).toBe('GBP');
    });

    it('takes the sale tax out of the value it is inside', () => {
        const c = computeValueComparison({ floorAreas: { built: 0, proposed: 300 }, ...prices, saleTaxShare: 0.25 });
        // 1,200,000 includes 25 % tax: 240,000 of it is tax.
        expect(c.columns.proposed.saleTax).toBeCloseTo(240000);
        expect(c.columns.proposed.profit).toBeCloseTo(1200000 - 600000 - 100000 - 240000);
    });

    it('greys out what is not there: no permitted massing, no proposed massing', () => {
        const c = computeValueComparison({ floorAreas: { built: 100, planned: null, proposed: 0 }, ...prices });
        expect(c.columns.planned).toMatchObject({ available: false, floorArea: null, value: null, totalCost: null, profit: null });
        expect(c.columns.proposed.available).toBe(false);
        expect(c.columns.built.available).toBe(true);
    });

    it('keeps a profit unknown while the built value, the land or its price is', () => {
        const noBuilt = computeValueComparison({ floorAreas: { built: null, planned: 400, proposed: 300 }, ...prices });
        expect(noBuilt.columns.built.available).toBe(false);
        expect(noBuilt.columns.proposed).toMatchObject({ available: true, value: 1200000, profit: null });
        const noLandPrice = computeValueComparison({ floorAreas: { built: 0, proposed: 300 }, ...prices, landPerM2: null });
        expect(noLandPrice.columns.proposed).toMatchObject({ constructionCost: 600000, landCost: null, totalCost: null, profit: null });
        const noLand = computeValueComparison({ floorAreas: { built: 0, proposed: 300 }, ...prices, landAreaM2: null });
        expect(noLand.columns.proposed.profit).toBeNull();
    });

    it('can lose money when building costs more than the floor area adds', () => {
        const c = computeValueComparison({ floorAreas: { built: 300, proposed: 320 }, ...prices });
        expect(c.columns.proposed.profit).toBe(320 * 2000 - 200 * 500 - 300 * 4000);
    });

    it('averages the proposed profit over the bound parcels and their land only', () => {
        const c = computeValueComparison({ floorAreas: { built: 0, proposed: 400 }, ...prices, parcelCount: 2,
            parcelFloorAreas: { built: 0, proposed: 200, land: 100 } });
        expect(c.columns.proposed.profit).toBe(400 * 2000 - 200 * 500);
        expect(c.avgProfitPerParcel).toBe((200 * 2000 - 100 * 500) / 2);
        expect(computeValueComparison({ floorAreas: { built: 0, proposed: 400 }, ...prices, parcelCount: null }).avgProfitPerParcel).toBeNull();
    });

    it('refuses prices without a currency', () => {
        expect(() => computeValueComparison({ floorAreas: { built: 1 }, salePerM2: 4000, constructionPerM2: 2000 })).toThrow(/currency/);
    });

    it('keeps amounts dependent on missing source prices unknown without hiding floor area', () => {
        const withoutSale = computeValueComparison({ floorAreas: { built: 100, proposed: 300 }, ...prices, salePerM2: null, parcelCount: 2 });
        expect(withoutSale.columns.built.value).toBeNull();
        expect(withoutSale.columns.proposed).toMatchObject({ available: true, floorArea: 300, value: null, constructionCost: 600000, landCost: 100000, profit: null });
        expect(withoutSale.avgProfitPerParcel).toBeNull();
        const withoutCost = computeValueComparison({ floorAreas: { built: 100, proposed: 300 }, ...prices, constructionPerM2: null });
        expect(withoutCost.columns.proposed).toMatchObject({ value: 1200000, constructionCost: null, profit: null });
    });
});
