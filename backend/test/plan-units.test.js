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
        const counted = units.countBuilding(rectangle(0, 0, 24, 12, { height: 15 }), { ...deps, heightM: 15, floorHeightM: 3 });
        expect(counted.reason).toBeUndefined();
        // Five storeys of the same plate: the count is a multiple of five.
        expect(counted.apartments).toBeGreaterThan(0);
        expect(counted.apartments % 5).toBe(0);
    });
    it('counts a building’s own floor plans, and leaves an uploaded model without them to the rule', () => {
        const floorPlans = { floors: [{ apartments: [{}, {}], units: [{ kind: 'shop', areaM2: 80 }] }, { apartments: [{}, {}, {}], units: [] }] };
        expect(units.countBuilding({ type: 'Feature', properties: { floorPlans }, geometry: null }, deps)).toEqual({ apartments: 5, shopNetM2: 80 });
        expect(units.countBuilding(rectangle(0, 0, 24, 12, { modelUrl: 'tower.glb' }), { ...deps, heightM: 30 })).toEqual({ reason: 'uploaded-model' });
    });
    it('says why a footprint gets no layout', () => {
        const kiosk = units.countBuilding(rectangle(0, 0, 3, 3), { ...deps, heightM: 6, floorHeightM: 3 });
        expect(kiosk.apartments).toBeUndefined();
        expect(typeof kiosk.reason).toBe('string');
    });
});

describe('a plan’s apartments', () => {
    it('takes each laid-out building’s count and applies the rule only to the floor area left', async () => {
        const block = rectangle(0, 0, 24, 12, { height: 15 });
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
        const block = rectangle(0, 0, 24, 12, { height: 15 });
        const total = planYield.planYield([design('d', [block])], { unitsOf: () => ({ apartments: 20, shopNetM2: 300 }), m2PerJob: 30 }).total;
        expect(total).toMatchObject({ apartments: 20, housingNetM2: 0, jobs: 10 });
    });
});
