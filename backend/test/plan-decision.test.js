// The decision-sheet rules of Compare plans (frontend/js/proposals/plan-decision.js), which MCP
// ugt_compare reads by too: built form, road and green area, demolition totals, build-out, the
// Permitted verdict, the Backing block's reading of an agreement and the CSV text.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';
import { authoredAreas } from '../agents/mcp-compare.js';

const require = createRequire(import.meta.url);
const decision = require('../../frontend/js/proposals/plan-decision.js');
const planYield = require('../../frontend/js/proposals/plan-yield.js');

const square = (x0, y0, x1, y1) => turf.bboxPolygon([x0, y0, x1, y1]);
const LAND = square(15.885, 43.735, 15.887, 43.7365);
const building = (feature, properties) => ({ ...feature, properties: { type: 'proposedBuilding', ...properties } });
const design = (id, buildings) => ({ proposalId: id, applied: true, buildingProposal: { buildings } });

describe('built form', () => {
    it('reads the tallest new building by plan-yield, and coverage and floor-area ratio over the land', () => {
        const west = building(square(15.885, 43.735, 15.886, 43.7365), { height: 30, floors: 10 });
        const east = building(square(15.886, 43.735, 15.887, 43.7365), { height: 12 });
        const form = decision.builtForm({ records: [design('a', [west]), design('b', [east])], landFeature: LAND, grossFloorAreaM2: 9000, turf });
        expect(form.maxHeightM).toBe(30);
        expect(form.maxStoreys).toBe(10);
        expect(form.siteCoveragePercent).toBeCloseTo(100, 0);
        expect(form.floorAreaRatio).toBeCloseTo(9000 / turf.area(LAND), 6);
    });

    it('counts a mansard roof in the tallest building, its storeys and the height the Permitted check takes', () => {
        const house = properties => building(square(15.885, 43.735, 15.8851, 43.7351), { height: 9, ...properties });
        const flat = decision.builtForm({ records: [design('a', [house({})])], turf });
        const mansard = decision.builtForm({ records: [design('a', [house({ roof: 'mansard' })])], turf });
        expect(flat).toMatchObject({ maxHeightM: 9, maxStoreys: 3 });
        expect(mansard.maxStoreys).toBe(4);
        expect(mansard.maxHeightM).toBeGreaterThan(9 + 2.25);
        expect(mansard.maxHeightM).toBeLessThanOrEqual(9 + 4.25);
        const [checked] = decision.permittedBuildings([design('a', [house({ roof: 'mansard' })])]);
        expect(checked).toMatchObject({ heightM: mansard.maxHeightM, floors: 4 });
    });

    it('leaves the ratios unknown without land, and the height unknown when no building states one', () => {
        const unstated = building(square(15.885, 43.735, 15.886, 43.7365), {});
        const form = decision.builtForm({ records: [design('a', [unstated])], grossFloorAreaM2: 0, turf });
        expect(form).toMatchObject({ buildings: 1, unmeasuredBuildings: 1, maxHeightM: null, maxStoreys: null, siteCoveragePercent: null, floorAreaRatio: null });
    });

    it('counts the existing buildings left standing in the coverage', () => {
        const half = building(square(15.885, 43.735, 15.886, 43.7365), { height: 9 });
        const standing = design('built:1', [building(square(15.886, 43.735, 15.8865, 43.7365), { height: 6 })]);
        const without = decision.builtForm({ records: [design('a', [half])], landFeature: LAND, turf }).siteCoveragePercent;
        const withIt = decision.builtForm({ records: [design('a', [half])], standing: [standing], landFeature: LAND, turf }).siteCoveragePercent;
        expect(without).toBeCloseTo(50, 0);
        expect(withIt).toBeCloseTo(75, 0);
    });
});

describe('road and green area', () => {
    const park = geometry => ({ structureProposal: { kind: 'park', geometry: geometry.geometry } });
    const road = geometry => ({ roadProposal: { definition: { polygon: geometry.geometry } } });
    it('unions overlapping parks and roads, and clips them to the land', () => {
        const a = square(15.885, 43.735, 15.886, 43.736), b = square(15.8855, 43.735, 15.8865, 43.736);
        const areas = decision.roadAndGreen([park(a), park(b), road(a)], { turf });
        expect(areas.greenAreaM2).toBeCloseTo(turf.area(turf.union(a, b)), 3);
        expect(areas.roadAreaM2).toBeCloseTo(turf.area(a), 3);
        const outside = square(15.887, 43.735, 15.888, 43.736);
        expect(decision.roadAndGreen([park(outside)], { turf, land: LAND }).greenAreaM2).toBe(0);
    });

    it('is the rule MCP ugt_compare reports', () => {
        const designs = [park(square(15.885, 43.735, 15.886, 43.736)), road(square(15.886, 43.735, 15.887, 43.736))];
        const mcp = authoredAreas(designs);
        const ui = decision.roadAndGreen(designs, { turf });
        expect(mcp.greenAreaM2).toBeCloseTo(ui.greenAreaM2, 6);
        expect(mcp.roadAreaM2).toBeCloseTo(ui.roadAreaM2, 6);
    });
});

describe('demolition totals', () => {
    it('counts whole and cut buildings, and leaves the floor area unknown while one has no height', () => {
        expect(decision.demolitionTotals([{ whole: true, footprintM2: 100, floorAreaM2: 300 }, { whole: false, footprintM2: 20, floorAreaM2: 40 }]))
            .toEqual({ buildingsRemoved: 1, buildingsCut: 1, removedFootprintM2: 120, removedFloorAreaM2: 340, unmeasured: 0 });
        expect(decision.demolitionTotals([{ whole: true, footprintM2: 100, floorAreaM2: null }]).removedFloorAreaM2).toBeNull();
        expect(decision.demolitionTotals([])).toMatchObject({ buildingsRemoved: 0, removedFloorAreaM2: 0 });
    });

    it('reads Plan stats\' cleared buildings by plan-yield', () => {
        const whole = square(15.885, 43.735, 15.886, 43.736), rest = square(15.885, 43.735, 15.8855, 43.736);
        const before = design('built:1', [building(whole, { height: 9 })]);
        const after = design('built:1', [building(rest, { height: 9 })]);
        const [row] = decision.clearedRows([{ before, after }]);
        expect(row.whole).toBe(false);
        expect(row.footprintM2).toBeCloseTo(planYield.geometryAreaM2(whole) - planYield.geometryAreaM2(rest), 3);
        expect(row.floorAreaM2).toBeCloseTo(row.footprintM2 * 3, 3);
    });
});

describe('build-out in brief', () => {
    it('gives the first and last period and the unscheduled designs, or null', () => {
        expect(decision.periodSummary({ byPeriod: [{ year: 2031 }, { year: 2028 }], unassigned: { proposals: 2 } }))
            .toEqual({ first: 2028, last: 2031, periods: 2, unscheduled: 2 });
        expect(decision.periodSummary({ byPeriod: [], unassigned: { proposals: 3 } })).toBeNull();
    });
});

describe('Permitted verdict', () => {
    const area = { a: 100, b: 200, c: null };
    it('counts the buildings over the limits and their floor area', () => {
        expect(decision.permittedSummary({ status: 'fail', buildings: { a: 'fail', b: 'fail', c: 'pass' } }, id => area[id]))
            .toMatchObject({ state: 'breaks', buildings: 3, breaking: 2, breakingFloorAreaM2: 300 });
        expect(decision.permittedSummary({ status: 'fail', buildings: { c: 'fail' } }, id => area[id]).breakingFloorAreaM2).toBeNull();
    });
    it('tells within, unclear, no source and an unreadable source apart', () => {
        expect(decision.permittedSummary({ status: 'pass', buildings: { a: 'pass' } }).state).toBe('within');
        expect(decision.permittedSummary({ status: 'unknown', buildings: { a: 'pass', b: 'unknown' } }).state).toBe('unclear');
        expect(decision.permittedSummary({ status: 'none', buildings: { a: 'none' } }).state).toBe('none');
        expect(decision.permittedSummary({ status: 'unavailable', buildings: {} }).state).toBe('unavailable');
    });
    it('hands the check each new building with its height, storeys and floor area', () => {
        const [first] = decision.permittedBuildings([design('d-1', [building(square(15.885, 43.735, 15.886, 43.736), { height: 12, floors: 4 })])]);
        expect(first).toMatchObject({ id: 'd-1#0', heightM: 12, floors: 4 });
        expect(first.floorAreaM2).toBeCloseTo(planYield.geometryAreaM2(first.footprint) * 4, 3);
    });
});

describe('backing agreements', () => {
    it('reads a crowdfunding round\'s lead, lens, threshold, target and deadline from its record', () => {
        const row = { cid: 'bafk-round', onchain: { cluster: 'devnet', account: 'Acc', status: 'active' },
            content: { title: 'Round', sponsor: 'Lead', deadline: '2027-11-24T12:00:00.000Z',
                rule: { electorate: 'investors', binding: true, lens: ['L1', { address: 'L2' }, 'L3'], lensThreshold: 2 }, funding: { targetUsdcAtomic: '2500000000' } } };
        expect(decision.backingOf(row)).toMatchObject({ cid: 'bafk-round', stage: 'minted', indexStatus: 'active', crowdfunding: true, lead: 'Lead',
            lenses: ['L1', 'L2', 'L3'], lensThreshold: 2, targetUsdcAtomic: '2500000000', deadline: '2027-11-24T12:00:00.000Z' });
    });
    it('names no lead or target for an owners\' agreement, and a local draft as a draft', () => {
        const owners = decision.backingOf({ title: 'Deal', rule: { electorate: 'owners', binding: true, lens: ['L1'] } });
        expect(owners).toMatchObject({ stage: 'draft', crowdfunding: false, lead: null, lenses: [], lensThreshold: null, targetUsdcAtomic: null });
    });
});

describe('CSV', () => {
    it('quotes cells holding commas, quotes or line breaks', () => {
        expect(decision.csvOf([['a', 'b, c'], ['say "hi"', 'x\ny'], [null, 3]])).toBe('a,"b, c"\r\n"say ""hi""","x\ny"\r\n,3\r\n');
    });
});
