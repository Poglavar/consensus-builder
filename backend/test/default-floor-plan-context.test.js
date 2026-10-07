// Parcel slicing, storey derivation, frontage, neighbours and caching around the default layout
// generator, driven with fakes so the behaviour is pinned without a browser.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const context = require('../../frontend/js/default-floor-plan-context.js');
const generator = require('../../frontend/js/default-floor-plans.js');
const plansModule = require('../../frontend/js/building-floor-plans.js');

const M_PER_DEG = Math.PI * 6378137 / 180, LAT = 45.8, LNG = 16.0, MX = M_PER_DEG * Math.cos(LAT * Math.PI / 180);
const lngLat = ([x, y]) => [LNG + x / MX, LAT + y / M_PER_DEG];
const rectangle = (cx, cy, w, h, properties = {}) => turf.polygon([[[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2], [cx - w / 2, cy - h / 2]].map(lngLat)], properties);
const latOf = y => LAT + y / M_PER_DEG, lngOf = x => LNG + x / MX;
const parcelA = rectangle(-10, 0, 20, 30, { parcelId: 'A' });
const parcelB = rectangle(10, 0, 20, 30, { parcelId: 'B' });

describe('parcel slices', () => {
    it('cuts a building spanning two parcels into one slice per parcel, west to east', () => {
        const building = rectangle(0, 0, 30, 12);
        const slices = context.sliceBuildingByParcels(building, [parcelB, parcelA], turf);
        expect(slices.map(slice => slice.parcelId)).toEqual(['A', 'B']);
        expect(slices.map(slice => Math.round(turf.area(slice.footprint)))).toEqual([180, 180]);
        expect(slices[0].parcelFeature).toBe(parcelA);
    });
    it('keeps the building whole when no parcel covers it or the slices cover under 95 % of it', () => {
        const away = rectangle(100, 0, 10, 10);
        expect(context.sliceBuildingByParcels(away, [parcelA, parcelB], turf)).toMatchObject([{ parcelId: null, unsliced: true }]);
        const overhanging = rectangle(-15, 0, 20, 12); // 15 m on parcel A, 5 m beyond its western edge
        expect(context.sliceBuildingByParcels(overhanging, [parcelA], turf)).toMatchObject([{ parcelId: null, unsliced: true }]);
    });
});

describe('storeys', () => {
    it('prefers declared storeys and shares the drawn height between them', () => {
        expect(context.storeysOf({ properties: { storeys: 5 } }, 17.5, 3.3)).toEqual({ floors: 5, storeyHeightM: 3.5 });
        expect(context.storeysOf({ properties: { floors: '4' } }, 12, 3.3)).toEqual({ floors: 4, storeyHeightM: 3 });
    });
    it('derives storeys from the height with the rule storey height, else the shared default', () => {
        const ruled = context.storeysOf({ properties: { urbanRule: { floorHeightM: 3 } } }, 10, 3.3);
        expect(ruled.floors).toBe(3);
        expect(ruled.storeyHeightM).toBeCloseTo(10 / 3, 9);
        expect(context.storeysOf({ properties: {} }, 10, 3.3)).toEqual({ floors: 3, storeyHeightM: 10 / 3 });
        expect(context.storeysOf({ properties: {} }, null, 3.3)).toEqual({ floors: null, storeyHeightM: 3.3 });
    });
});

describe('front and neighbours', () => {
    const road = (points, name = 'Ulica') => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: points.map(lngLat) }, properties: { name, highway: 'residential' } });

    it('puts the entrance on the longer side, choosing the long side that faces the nearer road at any distance', () => {
        const slice = rectangle(0, 0, 30, 12); // long sides at y = ±6, short sides at x = ±15
        const south = context.resolveFront(slice, [road([[-20, -40], [20, -40]])], { turf }); // 34 m away: no cutoff
        expect(south).toMatchObject({ basis: 'street', distanceM: 34, street: { name: 'Ulica', highway: 'residential' } });
        expect(south.a[1]).toBeCloseTo(latOf(-6), 9);
        expect(south.b[1]).toBeCloseTo(latOf(-6), 9);
        const north = context.resolveFront(slice, [road([[-20, 15], [20, 15]])], { turf });
        expect(north.a[1]).toBeCloseTo(latOf(6), 9);
        expect(north.b[1]).toBeCloseTo(latOf(6), 9);
        // A road past the short western end is nearer that end, but the entrance stays on a long side.
        const west = context.resolveFront(slice, [road([[-20, -30], [-20, 30]])], { turf });
        expect(Math.round(turf.distance(west.a, west.b, { units: 'meters' }))).toBe(30);
        expect(west.basis).toBe('longest');
        // No street data: the longest eligible edge.
        expect(context.resolveFront(slice, null, { turf })).toMatchObject({ basis: 'longest', street: null });
        expect(Math.round(turf.distance(context.resolveFront(slice, [], { turf }).a, context.resolveFront(slice, [], { turf }).b, { units: 'meters' }))).toBe(30);
    });
    it('never hosts the entrance on a party wall, and lets a near-square footprint face the nearest road', () => {
        const slice = rectangle(0, 0, 30, 12);
        const southRoad = road([[-20, -10], [20, -10]]);
        const blocked = context.resolveFront(slice, [southRoad], { turf, neighbours: [rectangle(0, -12, 30, 12)] });
        expect(blocked.a[1]).toBeCloseTo(latOf(6), 9); // the north long side, the road being behind a party wall
        expect(blocked.basis).toBe('longest');
        const square = rectangle(0, 0, 20, 19);
        const west = context.resolveFront(square, [road([[-15, -30], [-15, 30]])], { turf });
        expect(west.basis).toBe('street');
        expect(west.a[0]).toBeCloseTo(lngOf(-10), 9);
        expect(west.b[0]).toBeCloseTo(lngOf(-10), 9);
    });
    it('collects touching proposed and existing footprints, but not the building itself or a replaced one', () => {
        const owner = rectangle(0, 0, 20, 12, { proposalId: 'p1', buildingIndex: 0 });
        const self = rectangle(0, 0, 20, 12, { proposalId: 'p1', buildingIndex: 0 }); // the same building as its massing
        const sibling = rectangle(20, 0, 20, 12, { proposalId: 'p1', buildingIndex: 1 });
        const far = rectangle(200, 0, 20, 12, { proposalId: 'p2', buildingIndex: 0 });
        const touchingExisting = rectangle(-20, 0, 20, 12);
        const replacedExisting = rectangle(2, 0, 8, 8);
        const pool = context.neighbourPool(owner, [owner, self, sibling, far], [touchingExisting, replacedExisting], turf);
        expect(pool).toEqual([sibling, touchingExisting]);
    });
    it('keys street cells so each fetch spans well under the endpoint limit', () => {
        const key = context.streetCellKey(rectangle(0, 0, 20, 12), turf);
        expect(key).toBe(`${Math.floor(LNG / 0.005)}:${Math.floor(LAT / 0.005)}`);
        const bbox = context.streetCellBbox(key);
        expect(bbox[2] - bbox[0]).toBeCloseTo(0.007, 9);
        expect(bbox[3] - bbox[1]).toBeCloseTo(0.007, 9);
        expect(bbox[0]).toBeLessThan(LNG);
        expect(bbox[2]).toBeGreaterThan(LNG);
    });
});

describe('wings, blind facades, regions and eras', () => {
    const shape = points => turf.polygon([points.concat([points[0]]).map(lngLat)]);
    it('splits L, U and courtyard footprints into bar-like wings and leaves bars and jogged slabs whole', () => {
        const L = context.decomposeIntoWings(shape([[0, 0], [40, 0], [40, 14], [14, 14], [14, 40], [0, 40]]), turf);
        expect(L.wings).toHaveLength(2);
        expect(L.dropped).toBe(0);
        L.wings.forEach(wing => expect(Math.round(turf.area(wing))).toBeGreaterThan(400));
        const U = context.decomposeIntoWings(shape([[0, 0], [50, 0], [50, 30], [36, 30], [36, 14], [14, 14], [14, 30], [0, 30]]), turf);
        expect(U.wings).toHaveLength(3);
        const ring = turf.polygon([[[0, 0], [50, 0], [50, 40], [0, 40], [0, 0]].map(lngLat), [[14, 14], [14, 26], [36, 26], [36, 14], [14, 14]].map(lngLat)]);
        const courtyard = context.decomposeIntoWings(ring, turf);
        expect(courtyard.wings).toHaveLength(4);
        expect(courtyard.wings.every(wing => wing.geometry.coordinates.length === 1)).toBe(true); // no wing keeps a hole
        expect(context.decomposeIntoWings(rectangle(0, 0, 40, 12), turf).wings).toHaveLength(1);
        const jog = shape([[0, 0], [30, 0], [30, 3], [60, 3], [60, 15], [30, 15], [30, 12], [0, 12]]);
        expect(context.decomposeIntoWings(jog, turf).wings).toHaveLength(1); // a 3 m jog is not a corner between wings
        const bumpOuts = shape([[-7, 2], [0, 2], [0, 0], [60, 0], [60, 2], [67, 2], [67, 20], [-7, 20]]);
        expect(context.decomposeIntoWings(bumpOuts, turf).wings).toHaveLength(1);
    });
    it('plans each wing of a courtyard block as its own building with the other wings as party walls', () => {
        const ring = turf.polygon([[[0, 0], [50, 0], [50, 40], [0, 40], [0, 0]].map(lngLat), [[14, 14], [14, 26], [36, 26], [36, 14], [14, 14]].map(lngLat)]);
        ring.properties = { proposalId: 'p9', buildingIndex: 0, storeys: 5 };
        const planned = context.planBuilding(ring, { turf, generator, parcels: [], neighbours: [], roads: null, heightM: 15, storeyFallbackM: 3, rules: { garage: 'never' } });
        expect(planned.slices).toHaveLength(4);
        expect(planned.slices.map(slice => slice.wing)).toEqual([0, 1, 2, 3]);
        planned.slices.forEach(slice => expect(slice.result.floorPlans).not.toBeNull());
        expect(planned.slices.map(slice => slice.result.summary.cores).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(4);
        // Every wing's entrance facade is an outer facade of the block: on the ring's outline, not on the courtyard.
        planned.slices.forEach(slice => {
            const edge = slice.result.summary.frontEdge;
            const mid = [(edge.a[0] + edge.b[0]) / 2, (edge.a[1] + edge.b[1]) / 2];
            const x = (mid[0] - LNG) * MX, y = (mid[1] - LAT) * M_PER_DEG;
            expect(Math.min(Math.abs(x), Math.abs(x - 50), Math.abs(y), Math.abs(y - 40))).toBeLessThan(0.05);
        });
    });
    it('keeps facades near the parcel boundary blind unless a road lies across it, and never the front', () => {
        const slice = rectangle(0, 0, 20, 12);
        const parcel = rectangle(0, 2, 22, 20); // 1 m beyond the east and west walls, 2 m beyond the south wall, 12 m beyond the north wall
        const front = { a: lngLat([-10, -6]), b: lngLat([10, -6]) };
        const blind = context.blindEdgesFor(slice, parcel, [], front, { turf, setbackM: 3 });
        const sides = blind.map(edge => Math.round(((edge.a[0] + edge.b[0]) / 2 - LNG) * MX));
        expect(sides.sort((a, b) => a - b)).toEqual([-10, 10]); // east and west walls only
        const road = { type: 'Feature', geometry: { type: 'LineString', coordinates: [lngLat([12, -20]), lngLat([12, 20])] }, properties: { name: 'East street' } };
        const withRoad = context.blindEdgesFor(slice, parcel, [road], front, { turf, setbackM: 3 });
        expect(withRoad.map(edge => Math.round(((edge.a[0] + edge.b[0]) / 2 - LNG) * MX))).toEqual([-10]);
        expect(context.blindEdgesFor(slice, null, [], front, { turf })).toEqual([]);
    });
    it('reads the regulation region from the city locale and picks era rules for existing buildings', () => {
        expect(context.regionOf({ currency: { locale: 'hr-HR' } })).toBe('HR');
        expect(context.regionOf({ currency: { locale: 'en-US' } })).toBe('US');
        expect(context.regionOf({})).toBeNull();
        expect(context.eraRulesFor({ properties: { year: 1912 } }, 3.6, 4)).toMatchObject({ era: 'prewar', liftPolicy: 'never', groundFloorUse: 'commercial' });
        expect(context.eraRulesFor({ properties: { start_date: '1968' } }, 2.9, 5)).toMatchObject({ era: 'postwar', liftFromFloors: 6 });
        expect(context.eraRulesFor({ properties: {} }, 3.5, 3)).toMatchObject({ era: 'prewar' });
        expect(context.eraRulesFor({ properties: {} }, 2.9, 6)).toMatchObject({ era: 'postwar' });
        expect(context.eraRulesFor({ properties: {} }, 3.1, 2)).toEqual({ era: 'contemporary' });
    });
    it('treats applied corridors and road parcels as roads for the entrance side', () => {
        const slice = rectangle(0, 0, 30, 12);
        const corridor = { type: 'Feature', geometry: { type: 'LineString', coordinates: [lngLat([-20, 12]), lngLat([20, 12])] }, properties: { proposalId: 'road-1', title: 'New street' } };
        const north = context.resolveFront(slice, [corridor], { turf });
        expect(north.basis).toBe('street');
        expect(north.street).toMatchObject({ name: 'New street', id: 'road-1' });
        expect(north.a[1]).toBeCloseTo(latOf(6), 9);
        const roadParcel = rectangle(0, -16, 60, 10, { parcelId: 'R', isRoad: true });
        const south = context.resolveFront(slice, [roadParcel], { turf });
        expect(south.basis).toBe('street');
        expect(south.a[1]).toBeCloseTo(latOf(-6), 9);
    });
});

describe('planBuilding', () => {
    const building = rectangle(0, 0, 30, 12, { proposalId: 'p1', buildingIndex: 3, storeys: 4 });
    const streets = [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [lngLat([-20, -10]), lngLat([20, -10])] }, properties: { name: 'South street' } }];

    it('plans every parcel slice once, with sibling slices as party-wall neighbours and the street as the front', () => {
        const spy = { planDefaultFloorPlans: vi.fn(generator.planDefaultFloorPlans) };
        const planned = context.planBuilding(building, { turf, generator: spy, parcels: [parcelA, parcelB], neighbours: [], roads: streets, heightM: 14, storeyFallbackM: 3.3 });
        expect(planned).toMatchObject({ floors: 4, storeyHeightM: 3.5 });
        expect(planned.slices.map(slice => slice.parcelId)).toEqual(['A', 'B']);
        expect(spy.planDefaultFloorPlans).toHaveBeenCalledTimes(2);
        const [firstInput] = spy.planDefaultFloorPlans.mock.calls[0];
        expect(firstInput).toMatchObject({ floors: 4, storeyHeightM: 3.5, buildingId: 'p1/3/0' });
        expect(firstInput.neighbours).toHaveLength(1); // the other slice
        expect(firstInput.front.basis).toBe('street');
        planned.slices.forEach((slice, index) => {
            expect(slice.result.floorPlans).not.toBeNull();
            expect(slice.result.summary.frontBasis).toBe('street');
            expect(slice.result.summary.frontEdge.a[1]).toBeLessThan(LAT); // the southern edge faces the street
            // The parcel boundary between the two slices is a party wall: the only openings with a
            // vertical run sit on the outer side wall (east for the eastern slice, west for the western).
            const toGround = plansModule.registrationToLngLat(slice.result.floorPlans);
            const openings = slice.result.floorPlans.layouts[1].architecture.openings.filter(o => ['window', 'glazedDoor'].includes(o.kind) && o.room !== 'entrance');
            const sideOpenings = openings.filter(o => Math.abs(o.a[1] - o.b[1]) > 1e-6);
            expect(sideOpenings.length).toBeGreaterThan(0);
            sideOpenings.forEach(o => {
                const x = (toGround(o.a[0], o.a[1])[0] - LNG) * MX;
                expect(index === 0 ? x < -14 : x > 14).toBe(true); // 15 m from the centre, on the outer walls
            });
        });
    });

    it('serves repeated requests from the cache and re-plans when the front or the shape changes', () => {
        const spy = { planDefaultFloorPlans: vi.fn(generator.planDefaultFloorPlans) };
        const cache = new Map();
        const base = { turf, generator: spy, parcels: [parcelA, parcelB], neighbours: [], roads: null, heightM: 14, storeyFallbackM: 3.3, cache };
        context.planBuilding(building, base);
        context.planBuilding(building, base);
        expect(spy.planDefaultFloorPlans).toHaveBeenCalledTimes(2);
        context.planBuilding(building, { ...base, roads: streets });
        expect(spy.planDefaultFloorPlans).toHaveBeenCalledTimes(4);
        context.planBuilding(rectangle(0, 0, 30, 14, building.properties), base);
        expect(spy.planDefaultFloorPlans).toHaveBeenCalledTimes(6);
        expect(cache.size).toBe(6);
    });

    it('reports a flagged slice without aborting the rest of the building', () => {
        const narrowParcel = rectangle(-13, 0, 6, 30, { parcelId: 'N' });
        const wideParcel = rectangle(5, 0, 30, 30, { parcelId: 'W' });
        const planned = context.planBuilding(building, { turf, generator, parcels: [narrowParcel, wideParcel], neighbours: [], streets: null, heightM: 14, storeyFallbackM: 3.3 });
        expect(planned.slices.map(slice => [slice.parcelId, slice.result.floorPlans === null])).toEqual([['N', true], ['W', false]]);
        expect(planned.slices[0].result.warnings.map(w => w.code)).toContain('core-does-not-fit');
    });
});
