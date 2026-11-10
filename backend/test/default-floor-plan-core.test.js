// The central-core suggested layouts (default-floor-plan-core.js): office buildings, towers and
// buildings of stepped parts get one core of stairs, lifts and toilets through every storey, open
// plan offices with a reception at the lifts, flats round a lobby ring, and a split core for many lifts.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const plans = require('../../frontend/js/building-floor-plans.js');
const rooms = require('../../frontend/js/default-floor-plan-rooms.js');
const generator = require('../../frontend/js/default-floor-plans.js');
const core = require('../../frontend/js/default-floor-plan-core.js');

const M_PER_DEG = Math.PI * 6378137 / 180, LAT = 45.8, LNG = 16.0, MX = M_PER_DEG * Math.cos(LAT * Math.PI / 180);
const lngLat = ([x, y]) => [LNG + x / MX, LAT + y / M_PER_DEG];
const rectangle = (cx, cy, w, h) => turf.polygon([[[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2], [cx - w / 2, cy - h / 2]].map(lngLat)]);
const plan = (input, rules = {}) => generator.planDefaultFloorPlans(input, { turf, rooms, rules: { region: 'HR', garage: 'never', ...rules }, validate: plans.validateFloorPlans });
const layoutOfStorey = (result, level) => {
    const storey = result.floorPlans.storeys.find(s => s.level === level);
    return result.floorPlans.layouts.find(layout => layout.id === storey.layoutId).architecture;
};
const openings = (architecture, kind, room) => architecture.openings.filter(o => o.kind === kind && (room === undefined || o.room === room));
const polygonArea = rings => rings.reduce((sum, ring, index) => {
    let twice = 0;
    for (let i = 0; i < ring.length; i++) { const p = ring[i], q = ring[(i + 1) % ring.length]; twice += p[0] * q[1] - q[0] * p[1]; }
    return sum + (index === 0 ? 1 : -1) * Math.abs(twice / 2);
}, 0);

describe('central-core layouts', () => {
    it('lays out an office building round one core: stairs, lifts and toilets, a reception at the lifts, offices on every storey', () => {
        const result = plan({ footprint: rectangle(0, 0, 32, 20), floors: 6, storeyHeightM: 3.6, storeyUses: Array(6).fill('office'), buildingId: 'office' });
        expect(result.floorPlans).not.toBeNull();
        expect(result.summary).toMatchObject({ scheme: 'core', coreType: 'single', officeStoreys: 6, apartmentsPerFloor: 0, lift: true, highRise: false });
        expect(result.floorPlans.storeys.map(storey => storey.units.map(unit => unit.kind))).toEqual(Array(6).fill(['office']));
        const typical = layoutOfStorey(result, 2);
        // One lift per 3500 m² of floor (6 × 640 m²), one stair below the high-rise limit and 900 m².
        expect(openings(typical, 'slidingDoor', 'lift')).toHaveLength(2);
        expect(typical.stairs.filter(stair => stair.fromM === 0)).toHaveLength(1);
        expect(openings(typical, 'glazedDoor', 'reception')).toHaveLength(1);
        expect(openings(typical, 'door', 'wc').length).toBeGreaterThan(0);
        // The street door only on the ground floor; windows on the facades of every storey.
        expect(openings(layoutOfStorey(result, 0), 'glazedDoor', 'entrance')).toHaveLength(1);
        expect(openings(typical, 'glazedDoor', 'entrance')).toHaveLength(0);
        expect(openings(typical, 'window').filter(o => o.room === undefined).length).toBeGreaterThan(20);
        expect(result.floorPlans.notes.join(' ')).toMatch(/office storey/);
    });

    it('plans a building of stepped parts as one: each storey on the parts that reach it, offices in the podium, flats round the core above', () => {
        // A 17-storey slab with a four-storey podium beside it, the vLAB tower's shape, drawn 2 cm apart.
        const shaft = rectangle(0, 0, 27, 14), podium = rectangle(0, -13.02, 27, 12);
        const footprint = turf.union(shaft, podium);
        const uses = Array.from({ length: 17 }, (_, level) => (level < 4 ? 'office' : 'residential'));
        const result = plan({ footprint, floors: 17, storeyHeightM: 3.85, storeyUses: uses, buildingId: 'tower',
            plates: [{ footprint: podium, floors: 4 }, { footprint: shaft, floors: 17 }] });
        expect(result.floorPlans).not.toBeNull();
        expect(result.summary).toMatchObject({ scheme: 'core', highRise: true, stairs: 2, officeStoreys: 4 });
        expect(result.summary.lifts).toBeGreaterThanOrEqual(2);
        const { storeys } = result.floorPlans;
        expect(storeys).toHaveLength(17);
        storeys.slice(0, 4).forEach(storey => expect(storey.units.map(unit => unit.kind)).toEqual(['office']));
        storeys.slice(4).forEach(storey => {
            expect(storey.units.length).toBeGreaterThanOrEqual(2);
            storey.units.forEach(unit => { expect(unit.kind).toBe('apartment'); expect(unit.areaM2).toBeGreaterThanOrEqual(30); });
        });
        // The podium storeys stand on both parts, the storeys above on the slab alone.
        const podiumFloor = layoutOfStorey(result, 1), slabFloor = layoutOfStorey(result, 8);
        expect(podiumFloor.quality.floorAreaM2).toBeCloseTo(27 * 26, -1);
        // One floor across the seam between the parts, not two buildings wall to wall.
        expect(podiumFloor.slabs).toHaveLength(1);
        expect(slabFloor.quality.floorAreaM2).toBeCloseTo(27 * 14, -1);
        // The first storey above the podium stands on its roof: the slab spans the terrace.
        const terraceFloor = layoutOfStorey(result, 4);
        const [W, H] = terraceFloor.dimensionsM;
        const slabM2 = terraceFloor.slabs.reduce((sum, polygon) => sum + polygonArea(polygon), 0) * W * H;
        expect(slabM2).toBeGreaterThan(27 * 20);
        expect(layoutOfStorey(result, 5).slabs.reduce((sum, polygon) => sum + polygonArea(polygon), 0) * W * H).toBeLessThan(27 * 15);
        // Every flat has its door from the lobby ring; the stairs and lifts are the same on every storey.
        storeys.slice(4).forEach(storey => expect(openings(layoutOfStorey(result, storey.level), 'door', 'apartment')).toHaveLength(storey.units.length));
        const liftDoors = level => openings(layoutOfStorey(result, level), 'slidingDoor', 'lift').map(o => o.a.join(','));
        expect(liftDoors(0)).toEqual(liftDoors(16));
    });

    it('stands four lifts or more in two rows across a lift hall, with a reception at each end', () => {
        const result = plan({ footprint: rectangle(0, 0, 60, 40), floors: 12, storeyHeightM: 3.6, storeyUses: Array(12).fill('office'), buildingId: 'hq' });
        expect(result.summary).toMatchObject({ scheme: 'core', coreType: 'split', stairs: 2, highRise: true });
        const typical = layoutOfStorey(result, 3);
        expect(openings(typical, 'slidingDoor', 'lift')).toHaveLength(result.summary.lifts);
        expect(result.summary.lifts).toBeGreaterThanOrEqual(4);
        expect(openings(typical, 'glazedDoor', 'reception')).toHaveLength(2);
    });

    it('flags a tower whose top floor cannot hold a core with floor round it', () => {
        const result = plan({ footprint: rectangle(0, 0, 9, 8), floors: 12, storeyHeightM: 3, buildingId: 'needle' });
        expect(result.floorPlans).toBeNull();
        expect(result.warnings.map(w => w.code)).toContain('core-does-not-fit');
    });

    it('takes the central core for stepped parts, offices and compact towers, and leaves slabs and stated access to point cores and corridors', () => {
        const uses = n => Array(n).fill('residential');
        expect(core.wantsCentralCore({ footprint: rectangle(0, 0, 18, 18), floors: 12, storeyUses: uses(12) }, generator.rulesFor({}))).toBe(true);
        expect(core.wantsCentralCore({ footprint: rectangle(0, 0, 18, 18), floors: 12, storeyUses: uses(12) }, generator.rulesFor({ rules: { access: 'point' } }))).toBe(false);
        expect(core.wantsCentralCore({ footprint: rectangle(0, 0, 18, 18), floors: 6, storeyUses: uses(6) }, generator.rulesFor({}))).toBe(false);
        expect(core.wantsCentralCore({ footprint: rectangle(0, 0, 40, 12), floors: 12, storeyUses: uses(12) }, generator.rulesFor({}))).toBe(false);
        expect(core.wantsCentralCore({ footprint: rectangle(0, 0, 40, 12), floors: 3, storeyUses: ['office', 'office', 'residential'] }, generator.rulesFor({}))).toBe(true);
        expect(core.wantsCentralCore({ footprint: rectangle(0, 0, 40, 12), floors: 5, plates: [{}, {}] }, generator.rulesFor({}))).toBe(true);
        // A residential slab keeps its point cores.
        expect(plan({ footprint: rectangle(0, 0, 20, 12), floors: 4, storeyHeightM: 3, storeyUses: uses(4) }).summary.scheme).toBeUndefined();
    });
});
