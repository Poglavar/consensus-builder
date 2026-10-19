// Stats on open ground (PARCEL-OPTIONAL.md, phase 6): site metrics are always numbers; binding
// metrics (parcel counts, grain, per-parcel gain and payout) are null — never 0 — when a proposal
// binds no cadastral parcel, and cover only the bound parcels when the site is partly open ground.
// Cadastral proposals keep the figures they had.
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const siteStats = require('../../frontend/js/proposals/site-stats.js');
const planYield = require('../../frontend/js/proposals/plan-yield.js');
const grainRules = require('../../frontend/js/proposals/grain-score-rules.js');
const gain = require('../../frontend/js/proposals/gain.js');
const { calculatePayoutPerParcel } = require('../../frontend/js/financials.js');

const rect = (lon0, lat0, lon1, lat1) => [[[lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0]]];
const SITE = { type: 'MultiPolygon', coordinates: [rect(15.9, 43.7, 15.901, 43.701)] };
const SITE_M2 = planYield.geometryAreaM2(SITE);

// Bare ground: material proposal, empty declaration, its site, the server's empty binding.
const bare = (coverage = 'none') => ({
    applied: true,
    goal: 'park',
    cadastreParcelIds: [],
    site: SITE,
    binding: { parcels: [], coverage, unsurveyedM2: Math.round(SITE_M2 * 100) / 100, siteM2: Math.round(SITE_M2 * 100) / 100 }
});
// Partly bound: two parcels plus 300 m² of open ground.
const partial = () => ({
    applied: true,
    goal: 'buildings',
    cadastreParcelIds: ['HR-1-1', 'HR-1-2'],
    site: SITE,
    binding: {
        parcels: [{ parcelId: 'HR-1-1', overlapM2: 4000, intrusionM: 30 }, { parcelId: 'HR-1-2', overlapM2: 3000, intrusionM: 25 }],
        coverage: 'partial', unsurveyedM2: 300, siteM2: 7300
    }
});
// A cadastral proposal from before sites existed: declaration only.
const cadastral = () => ({ applied: true, goal: 'buildings', cadastreParcelIds: ['HR-2-1', 'HR-2-2', 'HR-2-3'] });

const isNumber = v => typeof v === 'number' && Number.isFinite(v);

describe('site-stats: one proposal', () => {
    it('bare ground: site area is a number, parcel count is null, the whole site is open ground', () => {
        const ground = siteStats.groundOf(bare());
        expect(isNumber(ground.siteM2)).toBe(true);
        expect(ground.siteM2).toBeGreaterThan(5000);
        expect(ground.hasBinding).toBe(false);
        expect(ground.parcelCount).toBeNull();
        expect(ground.openGroundM2).toBeCloseTo(SITE_M2, 0);
        expect(ground.partial).toBe(false);
    });

    it('bare ground with no binding object: site measured from the authored site', () => {
        const record = { goal: 'park', cadastreParcelIds: [], site: SITE };
        const ground = siteStats.groundOf(record);
        expect(ground.siteM2).toBeCloseTo(SITE_M2, 6);
        expect(ground.parcelCount).toBeNull();
        expect(ground.openGroundM2).toBeCloseTo(SITE_M2, 6);
    });

    it('partial: bound parcels counted, open ground from the binding', () => {
        const ground = siteStats.groundOf(partial());
        expect(ground.parcelCount).toBe(2);
        expect(ground.siteM2).toBe(7300);
        expect(ground.openGroundM2).toBe(300);
        expect(ground.partial).toBe(true);
    });

    it('cadastral: parcel count unchanged, open ground unknown rather than invented', () => {
        const ground = siteStats.groundOf(cadastral());
        expect(ground.parcelCount).toBe(3);
        expect(ground.openGroundM2).toBeNull();
        expect(ground.partial).toBe(false);
        const complete = siteStats.groundOf({ ...cadastral(), binding: { parcels: [], coverage: 'complete', siteM2: 900 } });
        expect(complete.openGroundM2).toBe(0);
        expect(complete.siteM2).toBe(900);
    });

    it('a piece minted on open ground is not a parcel', () => {
        expect(siteStats.isGroundPiece({ properties: { groundIds: ['ground:abc'], cadastreParcelIds: [] } })).toBe(true);
        expect(siteStats.isGroundPiece({ properties: { cadastreParcelIds: ['HR-1-1'] } })).toBe(false);
        expect(siteStats.isGroundPiece(null)).toBe(false);
    });
});

describe('site-stats: a plan', () => {
    it('all bare: no binding, open ground summed once per identical site', () => {
        const plan = siteStats.planGround([bare(), bare()]);
        expect(plan.hasBinding).toBe(false);
        expect(plan.bareProposals).toBe(2);
        expect(plan.openGroundM2).toBeCloseTo(SITE_M2, 0);
    });

    it('all bare and overlapping (a road through a subdivision): their union, not their sum', () => {
        const road = { ...bare(), goal: 'road-track', site: { type: 'MultiPolygon', coordinates: [rect(15.9004, 43.6995, 15.9006, 43.7015)] } };
        road.binding = { parcels: [], coverage: 'none', unsurveyedM2: planYield.geometryAreaM2(road.site) };
        const union = (a, b) => turf.union(a, b);
        const expected = planYield.geometryAreaM2(union({ type: 'Feature', properties: {}, geometry: SITE }, { type: 'Feature', properties: {}, geometry: road.site }).geometry);
        const plan = siteStats.planGround([bare(), road], { union });
        expect(plan.openGroundM2).toBeCloseTo(expected, 0);
        expect(plan.openGroundM2).toBeLessThan(SITE_M2 + road.binding.unsurveyedM2 - 1);
    });

    it('mixed: bound, with the open ground of the partial one', () => {
        const plan = siteStats.planGround([partial(), cadastral()]);
        expect(plan.hasBinding).toBe(true);
        expect(plan.partialProposals).toBe(1);
        expect(plan.openGroundM2).toBe(300);
    });

    it('cadastral only: no open ground stated, so none reported', () => {
        expect(siteStats.planGround([cadastral()]).openGroundM2).toBeNull();
    });
});

describe('plan-yield: the parcels a plan leaves standing', () => {
    it('bare ground binds nothing: bound is false and nothing is counted', () => {
        const pieces = [{ properties: { parcelId: 'ground:abc/1', groundIds: ['ground:abc'], cadastreParcelIds: [] } }];
        const result = planYield.resultingParcels([bare()], { materializedFeatures: pieces });
        expect(result.bound).toBe(false);
        expect(result.resulting).toEqual([]);
    });

    it('partial: only the bound parcels count; open-ground pieces are not parcels', () => {
        const pieces = [
            { properties: { parcelId: 'HR-1-1', cadastreParcelIds: ['HR-1-1'] } },
            { properties: { parcelId: 'HR-1-2', cadastreParcelIds: ['HR-1-2'] } },
            { properties: { parcelId: 'ground:abc/1', groundIds: ['ground:abc'], cadastreParcelIds: [] } }
        ];
        const result = planYield.resultingParcels([partial()], { materializedFeatures: pieces });
        expect(result.bound).toBe(true);
        expect(result.resulting.sort()).toEqual(['HR-1-1', 'HR-1-2']);
    });

    it('cadastral: unchanged, and bound', () => {
        const result = planYield.resultingParcels([cadastral()]);
        expect(result.bound).toBe(true);
        expect(result.resulting).toEqual(['HR-2-1', 'HR-2-2', 'HR-2-3']);
    });
});

describe('grain score', () => {
    it('a plan on open ground scores nothing: every figure null, not "unchanged, 50"', () => {
        const fabric = planYield.resultingParcels([bare()], { materializedFeatures: [] });
        const score = grainRules.scorePlan({
            beforeParcelCount: grainRules.startingParcelIds(fabric).length,
            afterParcelCount: fabric.resulting.length,
            parcels: [],
            bound: fabric.bound
        });
        expect(score.noParcels).toBe(true);
        expect(score.parcelCount).toBeNull();
        expect(score.totalScore).toBeNull();
        expect(score.fineGrain.score).toBeNull();
        expect(score.fineGrain.total).toBeNull();
        expect(score.verdict).toBe('unavailable');
    });

    it('partial and cadastral plans are scored over their bound parcels as before', () => {
        const score = grainRules.scorePlan({
            beforeParcelCount: 2,
            afterParcelCount: 4,
            parcels: [{ id: 'a', widthMeters: 8, depthMeters: 9 }, { id: 'b', widthMeters: 12, depthMeters: 20 }],
            bound: true
        });
        expect(score.parcelCount.score).toBe(100);
        expect(score.fineGrain.score).toBe(50);
        expect(score.totalScore).toBe(75);
        expect(score.noParcels).toBeUndefined();
    });
});

describe('gain over the site', () => {
    const opts = {
        floorHeightM: 3,
        turf,
        footprintOf: bld => bld.footprint,
        heightOf: feature => feature.properties.height
    };
    const siteFeature = turf.feature(SITE);
    const existing = { z_min: 0, z_max: 9, footprint: turf.polygon(rect(15.9, 43.7, 15.9005, 43.7005)) };
    const proposed = turf.polygon(rect(15.9, 43.7, 15.901, 43.701), { height: 12 });

    it('bare ground: totals measured over the site, parcel count and per-parcel average null', () => {
        const siteMetrics = gain.computeParcelMetrics(siteFeature, [existing], [proposed], opts);
        const ground = siteStats.groundOf(bare());
        expect(gain.needsSiteMetrics(ground)).toBe(true);
        const summary = gain.summarizeProposalGround({ parcelMetrics: [], siteMetrics, ground });
        expect(summary.source).toBe('site');
        expect(isNumber(summary.proposedFloorArea)).toBe(true);
        expect(summary.proposedFloorArea).toBeGreaterThan(summary.builtFloorArea);
        expect(summary.builtFloorArea).toBeGreaterThan(0);
        expect(summary.parcelCount).toBeNull();
        expect(isNumber(summary.siteM2)).toBe(true);
        const money = gain.computeGain({
            builtFloorArea: summary.builtFloorArea,
            proposedFloorArea: summary.proposedFloorArea,
            priceEurPerM2: 1000,
            parcelCount: summary.parcelCount,
            parcelFloorAreas: summary.parcelFloorAreas
        });
        expect(money.gain).toBeGreaterThan(0);
        expect(money.avg).toBeNull();
    });

    it('bare ground with nothing measurable: no summary rather than zeros', () => {
        expect(gain.summarizeProposalGround({ parcelMetrics: [], siteMetrics: null, ground: siteStats.groundOf(bare()) })).toBeNull();
    });

    it('partial: totals over the site, the average over the bound parcels only', () => {
        const parcelMetrics = [
            { builtVolume: 0, proposedVolume: 300, builtFloorArea: 0, proposedFloorArea: 100 },
            { builtVolume: 0, proposedVolume: 300, builtFloorArea: 0, proposedFloorArea: 100 }
        ];
        const siteMetrics = { builtVolume: 0, proposedVolume: 1200, builtFloorArea: 0, proposedFloorArea: 400 };
        const summary = gain.summarizeProposalGround({ parcelMetrics, siteMetrics, ground: siteStats.groundOf(partial()) });
        expect(summary.source).toBe('site');
        expect(summary.proposedFloorArea).toBe(400);
        expect(summary.parcelCount).toBe(2);
        expect(summary.openGroundM2).toBe(300);
        const money = gain.computeGain({ ...summary, priceEurPerM2: 10 });
        expect(money.gain).toBe(4000);
        expect(money.avg).toBe(1000);           // (200 m² over the parcels × 10) / 2, not 4000 / 2
    });

    it('cadastral: the per-parcel sum, exactly as before', () => {
        const parcelMetrics = [
            { builtVolume: 30, proposedVolume: 90, builtFloorArea: 10, proposedFloorArea: 30 },
            { builtVolume: 60, proposedVolume: 60, builtFloorArea: 20, proposedFloorArea: 20 }
        ];
        const ground = siteStats.groundOf(cadastral());
        expect(gain.needsSiteMetrics(ground)).toBe(false);
        const summary = gain.summarizeProposalGround({ parcelMetrics, siteMetrics: null, ground });
        expect(summary).toMatchObject({ source: 'parcels', builtFloorArea: 30, proposedFloorArea: 50, parcelCount: 2, parcelFloorAreas: null });
        expect(gain.computeGain({ ...summary, priceEurPerM2: 100 }).avg).toBe(1000);
        // Unknown ground (no site-stats loaded): the old behaviour, a count even when 0.
        expect(gain.summarizeProposalGround({ parcelMetrics: [], siteMetrics: null, ground: null }).parcelCount).toBe(0);
    });
});

describe('density over the ground', () => {
    let summarizeDensity;
    beforeAll(async () => {
        await import('../../frontend/js/building-density-stats.js');
        summarizeDensity = globalThis.BuildingDensityStats.summarizeDensity;
    });
    const building = turf.polygon(rect(15.9, 43.7, 15.9005, 43.7005), { storeys: 2 });

    it('over a drawn site: coverage and kin are numbers', () => {
        const stats = summarizeDensity({ parcelFeature: turf.feature(SITE), buildings: [building], turf });
        expect(stats.siteCoveragePercent).toBeCloseTo(25, 0);
        expect(stats.kin).toBeCloseTo(0.5, 1);
    });

    it('with no ground polygon: ratios are null, not 0', () => {
        const stats = summarizeDensity({ parcelFeature: null, buildings: [building], turf });
        expect(stats.siteCoveragePercent).toBeNull();
        expect(stats.kin).toBeNull();
        expect(stats.footprintAreaM2).toBeGreaterThan(0);
    });
});

describe('payout per parcel', () => {
    it('is null with no parcels (nobody to pay), not 0', () => {
        expect(calculatePayoutPerParcel(10, 0)).toBeNull();
        expect(calculatePayoutPerParcel(10, null)).toBeNull();
    });

    it('divides the budget over the bound parcels', () => {
        expect(calculatePayoutPerParcel(10, 4)).toBe(2.5);
    });
});

describe('every groundStats string is translated', () => {
    const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    const sources = [
        '../../frontend/js/proposals/plan-stats.js',
        '../../frontend/js/proposals/grain-score.js',
        '../../frontend/js/three-mode.js'
    ].map(read).join('\n');
    const keys = [...new Set([...sources.matchAll(/'groundStats\.([A-Za-z]+)'/g)].map(m => m[1]))];

    it('the surfaces ask for them', () => {
        expect(keys).toEqual(expect.arrayContaining(['noParcels', 'openGroundNote', 'grainNoParcels', 'siteAreaValue', 'openGroundValue']));
    });

    it.each(['en', 'hr', 'es', 'sr'])('%s has all of them, with {{area}} where a figure goes', locale => {
        const ground = JSON.parse(read(`../../frontend/i18n/${locale}.json`)).groundStats || {};
        keys.forEach(key => expect(typeof ground[key], `${locale}.groundStats.${key}`).toBe('string'));
        ['siteAreaValue', 'openGroundValue', 'openGroundNote'].forEach(key => expect(ground[key]).toMatch(/\{\{area\}\}/));
    });
});
