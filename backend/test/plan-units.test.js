// Apartments counted from generated layouts (plan-units.js) and how plan-yield.js takes them: a
// laid-out building brings its own apartments and shops, every other building keeps the per-m² rule.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const units = require('../../frontend/js/proposals/plan-units.js');
const planYield = require('../../frontend/js/proposals/plan-yield.js');
const context = require('../../frontend/js/default-floor-plan-context.js');
const generator = require('../../frontend/js/default-floor-plans.js');
require('../../frontend/js/building-floor-plans.js');

const M_PER_DEG = Math.PI * 6378137 / 180, LAT = 45.8, LNG = 16.0, MX = M_PER_DEG * Math.cos(LAT * Math.PI / 180);
const lngLat = ([x, y]) => [LNG + x / MX, LAT + y / M_PER_DEG];
const rectangle = (cx, cy, w, h, properties = {}) => turf.polygon([[[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2], [cx - w / 2, cy - h / 2]].map(lngLat)], properties);
const design = (id, features) => ({ proposalId: id, applied: true, geometry: { buildings: features }, buildingProposal: {} });
const deps = { context, generator, turf };

describe('counting a building', () => {
    it('lays a residential block out and counts the apartments on every floor', () => {
        const counted = units.countBuilding(rectangle(0, 0, 24, 12, { height: 15, use: 'residential' }), { ...deps, heightM: 15, floorHeightM: 3 });
        expect(counted.reason).toBeUndefined();
        // Five storeys of the same plate: the count is a multiple of five.
        expect(counted.apartments).toBeGreaterThan(0);
        expect(counted.apartments % 5).toBe(0);
    });
    it('counts a building’s own floor plans, and leaves an uploaded model without them to the rule', () => {
        const apartment = { kind: 'apartment' };
        const floorPlans = { storeys: [{ units: [apartment, apartment, { kind: 'shop', areaM2: 80 }] }, { units: [apartment, apartment, apartment, { kind: 'office', areaM2: 120 }] }] };
        expect(units.countBuilding({ type: 'Feature', properties: { floorPlans }, geometry: null }, deps)).toEqual({ apartments: 5, shopNetM2: 80, workNetM2: 120 });
        expect(units.countBuilding(rectangle(0, 0, 24, 12, { modelUrl: 'tower.glb' }), { ...deps, heightM: 30 })).toEqual({ reason: 'uploaded-model' });
    });
    it('says why a footprint gets no layout', () => {
        const kiosk = units.countBuilding(rectangle(0, 0, 3, 3, { use: 'residential' }), { ...deps, heightM: 6, floorHeightM: 3 });
        expect(kiosk.apartments).toBeUndefined();
        expect(typeof kiosk.reason).toBe('string');
    });
});

describe('the use decides what is laid out', () => {
    const block = properties => rectangle(0, 0, 24, 12, { height: 15, ...properties });
    const at = feature => ({ ...deps, heightM: 15, floorHeightM: 3 });
    it('lays out housing uses and a housing rule’s building, and leaves other or no stated uses to the rule', () => {
        expect(units.countBuilding(block({ use: 'office' }), at()).reason).toBe('not-housing');
        expect(units.countBuilding(block({ use: 'industrial' }), at()).reason).toBe('not-housing');
        expect(units.countBuilding(block({}), at()).reason).toBe('no-use');
        expect(units.countBuilding(block({ urbanRule: { typology: 'row' } }), at()).apartments).toBeGreaterThan(0);
        expect(units.countBuilding(block({ use: 'residential' }), { ...at(), existing: true }).reason).toBe('no-use');
    });
    it('puts shops on the ground floor for a use that has them, and counts mixed use’s first floor as offices', () => {
        const homes = units.countBuilding(block({ use: 'residential' }), at());
        const shops = units.countBuilding(block({ use: 'residential-shops' }), at());
        const mixed = units.countBuilding(block({ use: 'mixed' }), at());
        expect(homes.shopNetM2).toBe(0);
        expect(shops.shopNetM2).toBeGreaterThan(0);
        // Five storeys of the same plate: shops take the ground floor's apartments, offices the first's.
        const perFloor = homes.apartments / 5;
        expect(shops.apartments).toBe(perFloor * 4);
        expect(mixed.apartments).toBe(perFloor * 3);
        expect(mixed.workNetM2).toBeGreaterThan(0);
    });
    it('splits a building left to the rule by its stated use’s storeys', () => {
        const office = planYield.planYield([design('o', [block({ use: 'office' })])], { m2PerJob: 30 }).total;
        expect(office.apartments).toBe(0);
        expect(office.jobs).toBe(Math.floor(office.grossFloorAreaM2 * 0.8 / 30));
        const unstated = planYield.planYield([design('u', [block({})])], {}).total;
        const housing = planYield.planYield([design('h', [block({ use: 'residential' })])], {}).total;
        expect(housing.apartments).toBeGreaterThan(unstated.apartments);
        expect(housing.jobs).toBe(0);
    });
});

describe('a plan’s apartments', () => {
    it('takes each laid-out building’s count and applies the rule only to the floor area left', async () => {
        const block = rectangle(0, 0, 24, 12, { height: 15, use: 'residential' });
        const kiosk = rectangle(40, 0, 3, 3, { height: 6 });
        const records = [design('d', [block, kiosk])];
        const result = await units.count(records, deps);
        expect(result.laidOut).toBe(1);
        expect(result.estimated).toBe(1);
        const laid = result.unitsOf(block).apartments;
        const counted = planYield.planYield(records, { unitsOf: result.unitsOf }).total;
        const ruleOnly = planYield.planYield([design('k', [kiosk])], {}).total;
        expect(counted.laidOutBuildings).toBe(1);
        expect(counted.apartments).toBe(laid + ruleOnly.apartments);
        // Re-derived at another apartment size, only the rule's share moves.
        const bigger = planYield.rederive(planYield.planYield(records, { unitsOf: result.unitsOf }), { avgApartmentM2: 1000 }).total;
        expect(bigger.apartments).toBe(laid);
    });
    it('counts a laid-out building’s shops as work, and nothing of it as rule housing', () => {
        const block = rectangle(0, 0, 24, 12, { height: 15, use: 'residential' });
        const total = planYield.planYield([design('d', [block])], { unitsOf: () => ({ apartments: 20, shopNetM2: 300 }), m2PerJob: 30 }).total;
        expect(total).toMatchObject({ apartments: 20, housingNetM2: 0, jobs: 10 });
    });
});
