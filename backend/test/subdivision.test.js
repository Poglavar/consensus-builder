// Pure rules of subdivision (PARCEL-OPTIONAL.md phase 4, frontend/js/proposals/subdivision.js): the
// site pool split into bound parcels' parts and open ground, owner shares with an ownerless open
// part (no NaN, zero owners included), the open-ground ledger, the "plots along a street" layout
// tiling the site exactly, and plots given to the contributor whose ground they stand on.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const subdivision = require('../../frontend/js/proposals/subdivision.js');
const sitePlots = require('../../frontend/js/proposals/site-plots.js');

const LON = 139.76;
const LAT = 35.68;
const U = 1e-4; // ≈ 9 m east, 11 m north
const rect = (x0, y0, x1, y1) => ({
    type: 'Polygon',
    coordinates: [[[LON + x0 * U, LAT + y0 * U], [LON + x1 * U, LAT + y0 * U], [LON + x1 * U, LAT + y1 * U], [LON + x0 * U, LAT + y1 * U], [LON + x0 * U, LAT + y0 * U]]]
});
const area = g => turf.area(g.type === 'Feature' ? g : turf.feature(g));
const isNumber = value => typeof value === 'number' && Number.isFinite(value);

// The layout is a partition of the site: areas add up, nothing outside, no two pieces overlap.
function expectTiles(site, pieces) {
    const total = pieces.reduce((sum, g) => sum + area(g), 0);
    expect(total).toBeCloseTo(area(site), 0);
    let union = null;
    pieces.forEach(g => { union = union ? turf.union(union, turf.feature(g)) : turf.feature(g); });
    const outside = turf.difference(union, turf.feature(site));
    expect(outside ? area(outside) : 0).toBeLessThan(0.01);
    for (let i = 0; i < pieces.length; i += 1) {
        for (let j = i + 1; j < pieces.length; j += 1) {
            const hit = turf.intersect(turf.feature(pieces[i]), turf.feature(pieces[j]));
            expect(hit ? area(hit) : 0).toBeLessThan(0.01);
        }
    }
}

describe('sitePool', () => {
    it('splits a mixed site into the bound parcel\'s part and open ground', () => {
        const pool = subdivision.sitePool(rect(0, 0, 12, 6), [{ id: 'HR-1', geometry: rect(-6, 0, 6, 6) }], { turf });
        expect(pool.parts).toHaveLength(1);
        expect(pool.parts[0].parcelId).toBe('HR-1');
        // Only the part INSIDE the site contributes, not the whole parcel.
        expect(pool.parts[0].areaM2).toBeCloseTo(area(rect(0, 0, 6, 6)), 0);
        expect(pool.openGroundM2).toBeCloseTo(area(rect(6, 0, 12, 6)), 0);
        expect(pool.totalAreaM2).toBeCloseTo(area(rect(0, 0, 12, 6)), 0);
    });

    it('is all open ground on a bare site and none under full coverage', () => {
        expect(subdivision.sitePool(rect(0, 0, 4, 4), [], { turf })).toMatchObject({ parts: [], openGround: expect.any(Object) });
        const covered = subdivision.sitePool(rect(0, 0, 4, 4), [{ id: 'a', geometry: rect(0, 0, 2, 4) }, { id: 'b', geometry: rect(2, 0, 4, 4) }], { turf });
        expect(covered.openGroundM2).toBe(0);
        expect(covered.openGround).toBeNull();
        expect(covered.parts.map(part => part.parcelId)).toEqual(['a', 'b']);
    });
});

describe('poolShares', () => {
    it('gives zero owners one ownerless open-ground share, never NaN', () => {
        const { shares, basis, poolUnitValue, totalValue } = subdivision.poolShares([], { openGroundM2: 5000 });
        expect(shares).toEqual([expect.objectContaining({ ownerKey: 'open-ground', percent: 1, area: 5000, value: null, noOwner: true })]);
        expect(basis).toBe('area');
        expect(poolUnitValue).toBeNull();
        expect(totalValue).toBeNull();
    });

    it('returns no shares (not NaN shares) for an empty pool', () => {
        expect(subdivision.poolShares([], { openGroundM2: 0 }).shares).toEqual([]);
        expect(subdivision.poolShares([{ ownerKey: 'a', area: 0, value: 0 }], {}).shares).toEqual([]);
        expect(subdivision.poolShares(null, { openGroundM2: NaN }).shares).toEqual([]);
    });

    it('measures a mixed pool by area: open ground has no known value', () => {
        const { shares, basis, poolUnitValue } = subdivision.poolShares([
            { ownerKey: 'a', displayName: 'A', area: 300, value: 90000, parcelIds: ['HR-1'] },
            { ownerKey: 'b', displayName: 'B', area: 100, value: 10000, parcelIds: ['HR-2'] }
        ], { openGroundM2: 600 });
        expect(basis).toBe('area');
        expect(poolUnitValue).toBeNull();
        expect(shares.map(entry => [entry.ownerKey, entry.percent])).toEqual([['a', 0.3], ['b', 0.1], ['open-ground', 0.6]]);
        shares.forEach(entry => expect(isNumber(entry.percent)).toBe(true));
    });

    it('keeps the value basis of an ordinary pool with no open ground', () => {
        const { shares, basis, poolUnitValue } = subdivision.poolShares([
            { ownerKey: 'a', area: 300, value: 90000 },
            { ownerKey: 'b', area: 100, value: 10000 }
        ], { openGroundM2: 0 });
        expect(basis).toBe('value');
        expect(poolUnitValue).toBe(250);
        expect(shares.map(entry => entry.percent)).toEqual([0.9, 0.1]);
    });
});

describe('ledgerOf', () => {
    it('owes and pays nothing for open ground (balance null), with numbers everywhere else', () => {
        const ledger = subdivision.ledgerOf({ ownerKey: 'open-ground', area: 600, value: null, noOwner: true },
            { basis: 'area', poolUnitValue: null, assignedArea: 450 });
        expect(ledger).toMatchObject({ contributed: 600, entitled: 600, assigned: 450, assignedArea: 450, cashBalance: null, noOwner: true });
    });

    it('never yields NaN for an owner with missing numbers', () => {
        const ledger = subdivision.ledgerOf({ ownerKey: 'a', area: undefined, value: null }, { basis: 'value', poolUnitValue: null, assignedArea: NaN });
        Object.entries(ledger).filter(([key]) => key !== 'noOwner').forEach(([, value]) => expect(isNumber(value)).toBe(true));
        expect(ledger.cashBalance).toBe(0);
    });
});

describe('streetPlotsLayout', () => {
    it('runs a street through the middle of a deep site and tiles it exactly with plots on both sides', () => {
        const site = rect(0, 0, 12, 6); // ≈ 108 × 67 m
        const layout = subdivision.streetPlotsLayout(site, { turf });
        expect(layout.placement).toBe('middle');
        expect(layout.street).toBeTruthy();
        expect(layout.plots.length).toBeGreaterThanOrEqual(8);
        expectTiles(site, [layout.street, ...layout.plots]);
        // The street is about STREET_WIDTH_M wide along the whole frontage.
        const frontage = sitePlots.frontageEdges(site, { turf }).find(edge => edge.index === layout.frontageEdgeIndex);
        expect(area(layout.street) / frontage.lengthM).toBeCloseTo(subdivision.STREET_WIDTH_M, 0);
    });

    it('puts the street along the frontage of a shallow site, and only plots on a very shallow one', () => {
        const shallow = rect(0, 0, 12, 2.4); // ≈ 27 m deep
        const along = subdivision.streetPlotsLayout(shallow, { turf });
        expect(along.placement).toBe('frontage');
        expectTiles(shallow, [along.street, ...along.plots]);
        const thin = rect(0, 0, 12, 1.5); // ≈ 17 m
        const plotsOnly = subdivision.streetPlotsLayout(thin, { turf });
        expect(plotsOnly.street).toBeNull();
        expectTiles(thin, plotsOnly.plots);
    });

    it('works on a rotated, non-rectangular pool with no parcel boundaries inside', () => {
        const centre = [LON + 6 * U, LAT + 3 * U];
        const site = turf.transformRotate(turf.polygon([[
            [LON, LAT], [LON + 14 * U, LAT], [LON + 12 * U, LAT + 7 * U], [LON + 2 * U, LAT + 8 * U], [LON, LAT]
        ]]), 33, { pivot: centre }).geometry;
        const layout = subdivision.streetPlotsLayout(site, { turf });
        expect(layout.plots.length).toBeGreaterThan(4);
        expectTiles(site, [layout.street, ...layout.plots].filter(Boolean));
    });

    it('turns the street to another frontage edge on request', () => {
        const site = rect(0, 0, 12, 6);
        const a = subdivision.streetPlotsLayout(site, { turf, frontageEdgeIndex: 0 });
        const b = subdivision.streetPlotsLayout(site, { turf, frontageEdgeIndex: 1 });
        expect(b.frontageEdgeIndex).toBe(1);
        expect(JSON.stringify(a.street)).not.toBe(JSON.stringify(b.street));
        expectTiles(site, [b.street, ...b.plots]);
    });
});

describe('ownerKeyByGround', () => {
    it('gives a plot to the owner whose parcel it stands on, else to open ground', () => {
        const site = rect(0, 0, 12, 6);
        const pool = subdivision.sitePool(site, [{ id: 'HR-1', geometry: rect(0, 0, 6, 6) }], { turf });
        const { shares } = subdivision.poolShares([{ ownerKey: 'ana', area: pool.parts[0].areaM2, parcelIds: ['HR-1'] }], { openGroundM2: pool.openGroundM2 });
        expect(subdivision.ownerKeyByGround(rect(1, 1, 3, 3), pool, shares, { turf })).toBe('ana');
        expect(subdivision.ownerKeyByGround(rect(8, 1, 10, 3), pool, shares, { turf })).toBe('open-ground');
        expect(subdivision.ownerKeyByGround(rect(50, 50, 51, 51), pool, shares, { turf })).toBeNull();
    });
});
